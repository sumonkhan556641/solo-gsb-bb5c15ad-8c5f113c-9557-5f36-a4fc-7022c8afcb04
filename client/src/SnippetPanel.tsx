import { useState } from 'react';
import { CommandSnippet, Project } from './types';
import { collectSnippet } from './snippets';

/** 选中口令后的「保存为片段」区：实时预览沿出边可达的口令数与内部边数。 */
export function SnippetSaveSection(props: {
  project: Project;
  rootId: string;
  onCreate: (name: string) => void;
}) {
  const collected = collectSnippet(props.project, props.rootId);
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const canSave = trimmed !== '' && collected.nodeIds.length > 0;

  return (
    <div className="snippet-save">
      <h4>口令片段库</h4>
      <p className="hint">
        将该口令及沿出边可达的全部后继保存为命名片段；仅收录两端都在片段内的边。
      </p>
      <p className="hint snippet-count">
        将收录 <b>{collected.nodeIds.length}</b> 条口令、<b>{collected.edgeIds.length}</b> 条内部约束。
      </p>
      <label>
        片段名称
        <input
          value={name}
          placeholder="输入片段名称"
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSave) {
              props.onCreate(trimmed);
              setName('');
            }
          }}
        />
      </label>
      <button
        className="primary"
        disabled={!canSave}
        onClick={() => {
          props.onCreate(trimmed);
          setName('');
        }}
      >
        保存为片段
      </button>
    </div>
  );
}

/** 片段库列表：选择片段后在画布空白处点击放置；支持删除片段。 */
export function SnippetLibrary(props: {
  snippets: CommandSnippet[];
  placingSnippetId: string | null;
  onPlace: (snippetId: string) => void;
  onCancelPlacing: () => void;
  onDelete: (snippetId: string) => void;
}) {
  return (
    <div className="snippet-library">
      <h4>口令片段库（{props.snippets.length}）</h4>
      {props.placingSnippetId && (
        <p className="hint snippet-placing-hint">
          已选择「{props.snippets.find((s) => s.id === props.placingSnippetId)?.name ?? '片段'}」，
          请在画布空白处点击放置（根口令落在点击位置）；按 Esc 或点击下方按钮取消。
          <button className="snippet-cancel" onClick={props.onCancelPlacing}>
            取消放置
          </button>
        </p>
      )}
      {props.snippets.length === 0 ? (
        <p className="hint">
          暂无片段。选中一条口令后，在侧栏下方「口令片段库」中命名并保存其全部可达后继子图。
        </p>
      ) : (
        <ul className="snippet-list">
          {props.snippets.map((s) => {
            const isPlacing = props.placingSnippetId === s.id;
            return (
              <li key={s.id} className={`snippet-item ${isPlacing ? 'placing' : ''}`}>
                <div className="snippet-item-head">
                  <span className="snippet-name" title={s.name}>
                    {s.name}
                  </span>
                  <span className="snippet-meta">
                    {s.nodes.length} 口令 · {s.edges.length} 边
                  </span>
                </div>
                <div className="snippet-item-actions">
                  {isPlacing ? (
                    <button className="snippet-cancel" onClick={props.onCancelPlacing}>
                      取消放置
                    </button>
                  ) : (
                    <button className="primary" onClick={() => props.onPlace(s.id)}>
                      放置
                    </button>
                  )}
                  <button
                    className="snippet-del"
                    title="删除片段（不影响画布上已放置的副本与原图）"
                    onClick={() => props.onDelete(s.id)}
                  >
                    删除
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="hint snippet-note">
        放置时会为全部复制口令与约束生成新 ID 并整体平移，不自动连接原图；
        修改副本不影响片段与原图。片段随项目一起保存。
      </p>
    </div>
  );
}
