// Shared, scoped Mafs presentation for the board and the script-free PDF worker.
export const GRAPH_CSS = `
.rimo-graph{position:relative;overflow:hidden;background:#fff;color:#334155;font-family:'Noto Sans',sans-serif;font-variant-numeric:tabular-nums}
.rimo-graph .MafsView{display:block;background:var(--mafs-bg);overflow:hidden;user-select:none;outline:0;--mafs-bg:#fff;--mafs-fg:#334155;--mafs-origin-color:#64748b;--mafs-line-color:#e2e8f0;--mafs-line-stroke-dash-style:5,4;--mafs-axis-stroke-width:1.5px;--grid-line-subdivision-color:#f1f5f9}
.rimo-graph[data-graph-grid="false"] .MafsView{--mafs-line-color:transparent;--grid-line-subdivision-color:transparent}
.rimo-graph .MafsView text{fill:var(--mafs-fg);font-size:11px;font-family:inherit;cursor:inherit}
.rimo-graph .MafsView path{stroke:var(--mafs-fg)}
.rimo-graph .mafs-shadow{paint-order:stroke;stroke-width:3px;stroke:var(--mafs-bg);stroke-opacity:.9;stroke-linejoin:round}
.rimo-graph .rimo-graph-axis-label{position:absolute;font-size:12px;font-style:italic;pointer-events:none;background:#fffc;padding:0 2px;line-height:16px;color:#475569}
`;
