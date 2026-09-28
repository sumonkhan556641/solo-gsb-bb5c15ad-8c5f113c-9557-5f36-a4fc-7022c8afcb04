import { CommandEdge, CommandNode, CommandSnippet, Project } from './types';

export interface CollectedSnippet {
  /** 可达口令（含根口令） */
  nodeIds: string[];
  /** 两端均在可达集合内的边（片段内部边） */
  edgeIds: string[];
}

/**
 * 收集片段内容：从根口令出发沿出边可达的全部口令（含自身），
 * 以及两端均在可达集合内的边（通向片段外的边不收录）。
 * 图存在环时 BFS 的已访问集合仍可保证终止；根口令不存在时返回空结果。
 */
export function collectSnippet(project: Project, rootId: string): CollectedSnippet {
  const nodeIds = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const n of project.nodes) outgoing.set(n.id, []);
  for (const e of project.edges) {
    if (!outgoing.has(e.from) || !outgoing.has(e.to)) continue;
    outgoing.get(e.from)!.push(e.to);
  }
  if (!outgoing.has(rootId)) return { nodeIds: [], edgeIds: [] };

  const queue = [rootId];
  nodeIds.add(rootId);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const to of outgoing.get(id) ?? []) {
      if (!nodeIds.has(to)) {
        nodeIds.add(to);
        queue.push(to);
      }
    }
  }

  const edgeIds = project.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)).map((e) => e.id);
  return { nodeIds: [...nodeIds], edgeIds };
}

/** 按收集结果对当前图做深拷贝，组装为命名片段（ID 沿用原图，仅在片段内部引用）。 */
export function buildSnippet(project: Project, rootId: string, name: string): CommandSnippet | null {
  const collected = collectSnippet(project, rootId);
  if (collected.nodeIds.length === 0) return null;
  const idSet = new Set(collected.nodeIds);
  const edgeIdSet = new Set(collected.edgeIds);
  return {
    id: crypto.randomUUID(),
    name,
    rootId,
    nodes: project.nodes
      .filter((n) => idSet.has(n.id))
      .map((n) => ({ ...n })),
    edges: project.edges
      .filter((e) => edgeIdSet.has(e.id))
      .map((e) => ({ ...e })),
  };
}

export interface PlacedSnippet {
  nodes: CommandNode[];
  edges: CommandEdge[];
  /** 放置后根口令的新 ID（便于放置后选中） */
  newRootId: string;
}

/**
 * 实例化片段：生成全部节点与边的新 ID 并重映射边端点，
 * 以片段根口令原坐标为锚点整体平移到 (anchorX, anchorY)；
 * 保留名称、时长、用人数（不超过当前班组人数时原样，否则压减）与等待秒数。
 * 副本与片段、原图之间不存在任何共享引用。
 */
export function instantiateSnippet(
  snippet: CommandSnippet,
  anchorX: number,
  anchorY: number,
  crewCapacity?: number,
): PlacedSnippet | null {
  const root = snippet.nodes.find((n) => n.id === snippet.rootId);
  if (!root) return null;
  const dx = anchorX - root.x;
  const dy = anchorY - root.y;

  const idMap = new Map<string, string>();
  const nodes: CommandNode[] = snippet.nodes.map((n) => {
    const newId = crypto.randomUUID();
    idMap.set(n.id, newId);
    const crew =
      typeof n.crew === 'number' && Number.isInteger(n.crew) && n.crew >= 0
        ? typeof crewCapacity === 'number'
          ? Math.min(n.crew, crewCapacity)
          : n.crew
        : 0;
    return {
      id: newId,
      name: n.name,
      duration: n.duration,
      crew,
      x: Math.round(n.x + dx),
      y: Math.round(n.y + dy),
    };
  });

  const edges: CommandEdge[] = [];
  for (const e of snippet.edges) {
    const from = idMap.get(e.from);
    const to = idMap.get(e.to);
    // 服务端已校验端点均在片段内；缺失仅发生在数据损坏时，跳过该边
    if (!from || !to) continue;
    edges.push({ id: crypto.randomUUID(), from, to, minDelay: e.minDelay });
  }

  return { nodes, edges, newRootId: idMap.get(snippet.rootId)! };
}
