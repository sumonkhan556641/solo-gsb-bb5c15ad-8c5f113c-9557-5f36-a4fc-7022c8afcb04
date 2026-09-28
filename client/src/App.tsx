import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadProject, saveProject } from './api';
import { CrewPanel } from './CrewPanel';
import { GraphCanvas, Selection } from './GraphCanvas';
import { ReplanPanel } from './ReplanPanel';
import { computeCrewSchedule, computeReplan, computeSchedule } from './schedule';
import { SidePanel } from './SidePanel';
import { buildSnippet, instantiateSnippet } from './snippets';
import { Timeline } from './Timeline';
import { BreakPeriod, CommandEdge, CommandNode, CommandSnippet, Project, ScheduleResult } from './types';
import { useSimulation } from './useSimulation';

const EMPTY: Project = { nodes: [], edges: [] };

/** 兼容旧数据：班组人数缺省 1（正整数），口令用人数缺省 0（不超过班组人数的非负整数），休息时段缺省空。 */
function normalizeProject(p: Project): Project {
  const raw = p.crewSize;
  const crewSize =
    typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : 1;
  // 休息时段仅保留两端为有限数且 0≤起点<终点 的项（旧项目缺省为空）
  const breaks: BreakPeriod[] = Array.isArray(p.breaks)
    ? p.breaks
        .filter(
          (b): b is BreakPeriod =>
            !!b &&
            typeof b.start === 'number' &&
            typeof b.end === 'number' &&
            Number.isFinite(b.start) &&
            Number.isFinite(b.end) &&
            b.start >= 0 &&
            b.start < b.end,
        )
        .map((b, i) => ({
          id: typeof b.id === 'string' && b.id ? b.id : `break-${i}-${crypto.randomUUID()}`,
          start: b.start,
          end: b.end,
        }))
    : [];
  // 片段库：缺省为空（兼容旧项目），丢弃结构非法或内容为空的片段
  const snippets = sanitizeSnippets(p.snippets);
  return {
    ...p,
    crewSize,
    breaks,
    snippets,
    nodes: p.nodes.map((n) => {
      const c = n.crew;
      const crew =
        typeof c === 'number' && Number.isInteger(c) && c >= 0 ? Math.min(c, crewSize) : 0;
      return { ...n, crew };
    }),
  };
}

/** 片段库兜底：仅保留结构完整、根口令与内部边端点均合法的片段。 */
function sanitizeSnippets(raw: CommandSnippet[] | undefined): CommandSnippet[] {
  if (!Array.isArray(raw)) return [];
  const snippetIds = new Set<string>();
  const out: CommandSnippet[] = [];
  for (const s of raw) {
    if (!s || typeof s.id !== 'string' || s.id === '' || snippetIds.has(s.id)) continue;
    if (typeof s.name !== 'string' || s.name.trim() === '') continue;
    if (!Array.isArray(s.nodes) || !Array.isArray(s.edges) || s.nodes.length === 0) continue;
    const nodeIds = new Set<string>();
    const nodes: CommandNode[] = [];
    let bad = false;
    for (const n of s.nodes) {
      if (
        !n ||
        typeof n.id !== 'string' ||
        n.id === '' ||
        nodeIds.has(n.id) ||
        typeof n.name !== 'string' ||
        typeof n.duration !== 'number' ||
        !Number.isFinite(n.duration) ||
        n.duration < 0 ||
        typeof n.x !== 'number' ||
        typeof n.y !== 'number'
      ) {
        bad = true;
        break;
      }
      nodeIds.add(n.id);
      nodes.push({ ...n });
    }
    if (bad || !nodeIds.has(s.rootId)) continue;
    const edgeIds = new Set<string>();
    const edges: CommandEdge[] = [];
    for (const e of s.edges) {
      if (
        !e ||
        typeof e.id !== 'string' ||
        e.id === '' ||
        edgeIds.has(e.id) ||
        !nodeIds.has(e.from) ||
        !nodeIds.has(e.to) ||
        typeof e.minDelay !== 'number' ||
        !Number.isFinite(e.minDelay) ||
        e.minDelay < 0
      ) {
        bad = true;
        break;
      }
      edgeIds.add(e.id);
      edges.push({ ...e });
    }
    if (bad) continue;
    snippetIds.add(s.id);
    out.push({ id: s.id, name: s.name, rootId: s.rootId, nodes, edges });
  }
  return out;
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [selection, setSelection] = useState<Selection | null>(null);
  // 片段放置模式：非空时下一次画布空白点击放置该片段
  const [placingSnippetId, setPlacingSnippetId] = useState<string | null>(null);
  // 当前项目的同步引用：片段实例化需在状态更新器之外完成（StrictMode 下更新器会重复执行，
  // 不能在其中生成新 ID），放置以点击时刻的项目状态为准
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project;

  // 初始加载
  useEffect(() => {
    loadProject()
      .then((p) => setProject(normalizeProject(p)))
      .catch((e) => setLoadError(String(e?.message ?? e)));
  }, []);

  // 实时重算最早执行时间
  const schedule: ScheduleResult | null = useMemo(
    () => (project ? computeSchedule(project) : null),
    [project],
  );

  // 班组排程随编辑实时重算（有环时仅保留成环路径）
  const crewSchedule = useMemo(
    () => (project ? computeCrewSchedule(project) : null),
    [project],
  );

  // 出现环依赖时保留上次有效排程
  const [lastValid, setLastValid] = useState<ScheduleResult | null>(null);
  useEffect(() => {
    if (schedule?.ok) setLastValid(schedule);
  }, [schedule]);
  const effectiveSchedule = schedule?.ok ? schedule : lastValid;
  const cycle = schedule && !schedule.ok ? schedule.cycle : undefined;

  const sim = useSimulation(project ?? EMPTY, effectiveSchedule);

  // 现场续排：仅在暂停时打开；离开暂停（继续/重置）自动关闭
  const [replanOpen, setReplanOpen] = useState(false);
  useEffect(() => {
    if (sim.state !== 'paused') setReplanOpen(false);
  }, [sim.state]);

  // 暂停时刻的续排试算（纯内存，复用现有排程与模拟状态，不写入项目）
  const replan = useMemo(
    () => (replanOpen ? computeReplan(project ?? EMPTY, sim.runtime, sim.time) : null),
    [replanOpen, project, sim.runtime, sim.time],
  );

  // 待执行口令的现行触发时间：已确认的续排结果优先，否则取最早排程
  const currentTriggerStarts = useMemo(() => {
    const out: Record<string, number> = {};
    if (!project) return out;
    for (const n of project.nodes) {
      const t = sim.replanStarts[n.id] ?? effectiveSchedule?.starts[n.id];
      if (t !== undefined) out[n.id] = t;
    }
    return out;
  }, [project, sim.replanStarts, effectiveSchedule]);

  // 本地持久化（防抖）
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback((p: Project) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState('saving');
    saveTimer.current = setTimeout(() => {
      saveProject(p)
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('error'));
    }, 400);
  }, []);

  const update = useCallback(
    (fn: (p: Project) => Project) => {
      setProject((prev) => {
        if (!prev) return prev;
        const next = fn(prev);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const addNode = useCallback(() => {
    const id = crypto.randomUUID();
    update((p) => ({
      ...p,
      nodes: [
        ...p.nodes,
        { id, name: `口令${p.nodes.length + 1}`, duration: 3, crew: 0, x: 120 + p.nodes.length * 30, y: 120 + p.nodes.length * 24 },
      ],
    }));
    setSelection({ type: 'node', id });
  }, [update]);

  const moveNode = useCallback(
    (id: string, x: number, y: number) => {
      update((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) }));
    },
    [update],
  );

  const updateNode = useCallback(
    (id: string, patch: Partial<Pick<CommandNode, 'name' | 'duration' | 'crew'>>) => {
      update((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
    },
    [update],
  );

  const deleteNode = useCallback(
    (id: string) => {
      update((p) => ({
        nodes: p.nodes.filter((n) => n.id !== id),
        edges: p.edges.filter((e) => e.from !== id && e.to !== id),
      }));
      setSelection(null);
    },
    [update],
  );

  const addEdge = useCallback(
    (from: string, to: string) => {
      update((p) => {
        if (p.edges.some((e) => e.from === from && e.to === to)) return p;
        return { ...p, edges: [...p.edges, { id: crypto.randomUUID(), from, to, minDelay: 0 }] };
      });
    },
    [update],
  );

  const updateEdge = useCallback(
    (id: string, patch: { minDelay?: number }) => {
      update((p) => ({ ...p, edges: p.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
    },
    [update],
  );

  const deleteEdge = useCallback(
    (id: string) => {
      update((p) => ({ ...p, edges: p.edges.filter((e) => e.id !== id) }));
      setSelection(null);
    },
    [update],
  );

  const setDeadlineEnabled = useCallback(
    (enabled: boolean) => {
      update((p) => ({
        ...p,
        deadline: {
          enabled,
          // 首次启用时默认取当前最短工期，便于直接看到关键链
          seconds: p.deadline?.seconds ?? Math.ceil(effectiveSchedule?.makespan ?? 30),
        },
      }));
    },
    [update, effectiveSchedule],
  );

  const setDeadlineSeconds = useCallback(
    (seconds: number) => {
      update((p) => ({ ...p, deadline: { enabled: p.deadline?.enabled ?? true, seconds } }));
    },
    [update],
  );

  // 班组人数为正整数；下调时同步压减各口令（含片段库快照内）用人数，保持“用人数 ≤ 班组人数”
  const setCrewSize = useCallback(
    (crewSize: number) => {
      update((p) => ({
        ...p,
        crewSize,
        nodes: p.nodes.map((n) => ({ ...n, crew: Math.min(n.crew ?? 0, crewSize) })),
        snippets: (p.snippets ?? []).map((s) => ({
          ...s,
          nodes: s.nodes.map((n) => ({
            ...n,
            crew: Math.min(typeof n.crew === 'number' ? n.crew : 0, crewSize),
          })),
        })),
      }));
    },
    [update],
  );

  const addBreak = useCallback(() => {
    update((p) => ({
      ...p,
      breaks: [...(p.breaks ?? []), { id: crypto.randomUUID(), start: 0, end: 1 }],
    }));
  }, [update]);

  const updateBreak = useCallback(
    (id: string, patch: Partial<Pick<BreakPeriod, 'start' | 'end'>>) => {
      update((p) => ({
        ...p,
        breaks: (p.breaks ?? []).map((b) => (b.id === id ? { ...b, ...patch } : b)),
      }));
    },
    [update],
  );

  const deleteBreak = useCallback(
    (id: string) => {
      update((p) => ({ ...p, breaks: (p.breaks ?? []).filter((b) => b.id !== id) }));
    },
    [update],
  );

  // ---------------- 口令片段库 ----------------

  // 选中口令 → 保存其沿出边可达的全部后继（仅内部边）为命名片段
  const createSnippet = useCallback(
    (rootNodeId: string, name: string) => {
      const prev = projectRef.current;
      if (!prev) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      const snippet = buildSnippet(prev, rootNodeId, trimmed);
      if (!snippet) return;
      update((p) => ({ ...p, snippets: [...(p.snippets ?? []), snippet] }));
    },
    [update],
  );

  const deleteSnippet = useCallback(
    (snippetId: string) => {
      setPlacingSnippetId((cur) => (cur === snippetId ? null : cur));
      update((p) => ({ ...p, snippets: (p.snippets ?? []).filter((s) => s.id !== snippetId) }));
    },
    [update],
  );

  // 画布空白点击：以原根口令为锚点整体平移放置副本，全部 ID 重新生成
  const placeSnippet = useCallback(
    (snippetId: string, x: number, y: number) => {
      const prev = projectRef.current;
      if (!prev) return;
      const snippet = (prev.snippets ?? []).find((s) => s.id === snippetId);
      if (!snippet) return;
      // 在更新器之外完成实例化（生成新 ID 的过程不可重复），随后走统一更新/保存链
      const placed = instantiateSnippet(snippet, x, y, prev.crewSize ?? 1);
      if (!placed) return;
      update((p) => ({
        ...p,
        nodes: [...p.nodes, ...placed.nodes],
        edges: [...p.edges, ...placed.edges],
      }));
      setPlacingSnippetId(null);
      setSelection({ type: 'node', id: placed.newRootId });
    },
    [update],
  );

  // Esc 取消放置
  useEffect(() => {
    if (!placingSnippetId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlacingSnippetId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placingSnippetId]);

  if (loadError) {
    return <div className="boot-message">加载失败：{loadError}</div>;
  }
  if (!project) {
    return <div className="boot-message">正在加载口令沙盘…</div>;
  }

  const simActive = sim.state === 'running' || sim.state === 'paused';
  const canStart = project.nodes.length > 0 && sim.state !== 'running' && sim.state !== 'paused';
  const deadline = project.deadline;
  const backward = effectiveSchedule?.backward;
  // 已确认续排且仍在待执行的口令数（用于工具栏提示）
  const replanPending = Object.keys(sim.replanStarts).filter(
    (id) => (sim.runtime[id]?.status ?? 'pending') === 'pending',
  ).length;

  return (
    <div className="app">
      <header className="toolbar">
        <h1>舞台换景口令沙盘</h1>
        <button onClick={addNode}>＋ 添加口令</button>
        <span className="sep" />
        {sim.state === 'idle' || sim.state === 'finished' ? (
          <button className="primary" disabled={!canStart} onClick={sim.start}>
            ▶ 开始模拟
          </button>
        ) : sim.state === 'running' ? (
          <button className="primary" onClick={sim.pause}>⏸ 暂停</button>
        ) : (
          <button className="primary" onClick={sim.resume}>⏵ 继续</button>
        )}
        <button disabled={sim.state === 'idle'} onClick={sim.reset}>⟲ 重置</button>
        {sim.state === 'paused' && (
          <button
            title="以当前模拟时刻为待执行口令的最早起点，按前置等待、锁定口令的人手占用、班组容量与休息时段重排最早可行空档"
            onClick={() => setReplanOpen(true)}
          >
            ⚙ 现场续排
          </button>
        )}
        <span className="sim-clock">
          {sim.state !== 'idle' && `t = ${sim.time.toFixed(1)}s`}
          {sim.state === 'finished' && ' · 全部完成'}
        </span>
        {replanPending > 0 && <span className="replan-flag">已续排 {replanPending} 条</span>}
        <span className="sep" />
        <label className="deadline-toggle" title="按全部后继约束反向计算最晚开始与浮动">
          <input
            type="checkbox"
            checked={deadline?.enabled ?? false}
            onChange={(e) => setDeadlineEnabled(e.target.checked)}
          />
          开场截止
        </label>
        {deadline?.enabled && (
          <span className="deadline-ctrl">
            <input
              type="number"
              min={0}
              step={0.5}
              value={deadline.seconds}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0) setDeadlineSeconds(v);
              }}
            />
            <span className="deadline-unit">s</span>
            {backward && backward.overrun > 0 && (
              <span className="overrun">超期 {round1(backward.overrun)}s</span>
            )}
          </span>
        )}
        <span className="sep" />
        <label className="crew-ctrl" title="班组总人数（正整数）；班组排程中同一时刻总用人数不超过该值">
          班组人数
          <input
            type="number"
            min={1}
            step={1}
            value={project.crewSize ?? 1}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= 1) setCrewSize(v);
            }}
          />
          <span className="deadline-unit">人</span>
        </label>
        <span className="spacer" />
        <span className={`save-state ${saveState}`}>
          {saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中…' : '保存失败'}
        </span>
      </header>

      {cycle && (
        <div className="cycle-banner">
          ⚠ 检测到环依赖（{cycle.nodeIds.length} 条口令成环），已保留上次有效排程；成环路径已红色高亮。
        </div>
      )}

      {placingSnippetId && (
        <div className="placing-banner">
          正在放置片段「{project.snippets?.find((s) => s.id === placingSnippetId)?.name ?? '片段'}」：
          在画布空白处点击，根口令将落在点击位置；按 Esc 或
          <button className="placing-cancel" onClick={() => setPlacingSnippetId(null)}>
            取消
          </button>
        </div>
      )}

      <div className="main">
        <div className="canvas-wrap">
          <GraphCanvas
            project={project}
            schedule={effectiveSchedule}
            cycle={cycle}
            runtime={sim.runtime}
            selection={selection}
            placingSnippetId={placingSnippetId}
            onSelect={setSelection}
            onMoveNode={moveNode}
            onAddEdge={addEdge}
            onPlaceSnippet={placeSnippet}
            onCancelPlacing={() => setPlacingSnippetId(null)}
          />
        </div>
        <SidePanel
          project={project}
          schedule={effectiveSchedule}
          selection={selection}
          cycle={cycle}
          crewSize={project.crewSize ?? 1}
          snippets={project.snippets ?? []}
          placingSnippetId={placingSnippetId}
          onCreateSnippet={createSnippet}
          onPlaceSnippet={(id) => setPlacingSnippetId(id)}
          onCancelPlacingSnippet={() => setPlacingSnippetId(null)}
          onDeleteSnippet={deleteSnippet}
          onUpdateNode={updateNode}
          onUpdateEdge={updateEdge}
          onDeleteNode={deleteNode}
          onDeleteEdge={deleteEdge}
        />
      </div>

      <CrewPanel
        project={project}
        result={crewSchedule}
        cycle={cycle}
        onAddBreak={addBreak}
        onUpdateBreak={updateBreak}
        onDeleteBreak={deleteBreak}
      />

      <Timeline
        project={project}
        schedule={effectiveSchedule}
        cycle={cycle}
        runtime={sim.runtime}
        simTime={sim.time}
        simActive={simActive || sim.state === 'finished'}
        replanStarts={sim.replanStarts}
      />

      {replanOpen && (
        <ReplanPanel
          project={project}
          result={replan}
          cycle={cycle}
          currentStarts={currentTriggerStarts}
          now={sim.time}
          onConfirm={(starts) => {
            // 仅更新本次模拟的待执行触发时间，不写入项目
            sim.applyReplan(starts);
            setReplanOpen(false);
          }}
          onClose={() => setReplanOpen(false)}
        />
      )}
    </div>
  );
}

function round1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
