/** Connections keeps the card's main and supporting columns; wide tables scroll within their own card. */
export const CONNECTIONS_CSS = `
.connections-layout{grid-template-columns:minmax(0,2fr) minmax(280px,1fr)}
[data-page="connections"] .tbl{font-size:12px}
[data-page="connections"] .tbl th,[data-page="connections"] .tbl td{vertical-align:top;white-space:normal;overflow-wrap:anywhere}
[data-page="connections"] #p-forges .cn-forge-config .tbl{table-layout:fixed}
[data-page="connections"] #p-forges .cn-forge-config .tbl th:nth-child(1){width:84px}
[data-page="connections"] #p-forges .cn-forge-config .tbl td:first-child{white-space:nowrap}
[data-page="connections"] #p-forges .cn-forge-config .tbl th:nth-child(2){width:120px}
[data-page="connections"] #p-forges .cn-forge-config .tbl th:nth-child(3){width:135px}
[data-page="connections"] #p-forges .cn-forge-config .tbl th:nth-child(4){width:190px}
[data-page="connections"] #p-forges .cn-forge-config .tbl th:nth-child(5){width:140px}
[data-page="connections"] #p-forges .cn-forge-config .tbl th:nth-child(6){width:110px}
[data-page="connections"] #p-env .tbl th:first-child{width:44%;overflow-wrap:anywhere}
.cn-receiver-detail{margin:12px 0}
.cn-receiver-detail summary{cursor:pointer;color:var(--running-ink);font-size:12px}
.cn-receivers section+section{margin-top:20px}
.cn-receivers a{overflow-wrap:anywhere}
.cn-receiver-hours-scroll{max-width:100%;min-width:0;overflow-x:auto;margin-top:12px;border-radius:var(--radius-md)}
.cn-receiver-hours-scroll:focus-visible{outline:2px solid var(--running-ink);outline-offset:2px}
.cn-receiver-hours-scroll>.tbl-wrap{overflow:visible}
[data-page="connections"] .cn-receiver-hours-scroll .tbl{width:max-content;min-width:1320px;table-layout:auto}
[data-page="connections"] .cn-receiver-hours-scroll .tbl th,[data-page="connections"] .cn-receiver-hours-scroll .tbl td{white-space:nowrap;overflow-wrap:normal;word-break:normal}
.cn-env-rest{margin:12px 0}
.cn-env-rest summary{cursor:pointer;color:var(--running-ink);font-size:12px}
[data-page="connections"] .tbl .code{white-space:normal;overflow-wrap:anywhere}
[data-page="connections"] .card h3{font-size:13px;margin-top:20px}
.cn-note{display:flex;align-items:flex-start;gap:8px;margin-top:16px;color:var(--ink-muted)}
.cn-note,.cn-doc{font-size:12px;line-height:18px}
.cn-note>span{min-width:0}
.cn-note .code{white-space:normal;overflow-wrap:anywhere}
.cn-doc{margin-top:8px}
.cn-state{display:inline-flex;align-items:baseline;gap:4px;max-width:100%;color:var(--tone-ink);font-weight:600}
.cn-state>.ic{align-self:flex-start;margin-top:2px}
.cn-state>span{min-width:0;overflow-wrap:anywhere}
.cn-cell{display:flex;flex-direction:column;gap:4px;line-height:18px}
.cn-cell>small{color:var(--ink-muted);font-size:11px;line-height:16px}
.cn-hosts{display:flex;flex-wrap:wrap;gap:6px}
.cn-hosts .code{background:var(--surface-2);padding:3px 6px;border-radius:5px}
.cn-providers{margin-top:12px}
.cn-providers .rowpill,.cn-mcp .rowpill{min-height:36px;padding-top:5px;padding-bottom:5px;border-radius:var(--radius-md);line-height:17px;flex-wrap:wrap}
.cn-providers .rowpill>span,.cn-mcp .rowpill>span{min-width:0;overflow-wrap:anywhere}
.cn-providers .rowpill>span:not([class]),.cn-mcp .rowpill>span:not([class]){white-space:normal;flex:0 1 auto}
.cn-providers .rowpill>b,.cn-mcp .rowpill>b{min-width:0;overflow:visible;text-overflow:clip;white-space:normal;overflow-wrap:anywhere}
.cn-providers .code,.cn-mcp .code{white-space:normal;overflow-wrap:anywhere}
.cn-providers .end{font-size:11px}
.cn-mcp .end{max-width:100%;flex-wrap:wrap}
.cn-icon-list{display:grid;gap:12px}
.cn-icon-list>li{display:flex;gap:8px;align-items:flex-start}
.cn-icon-list>li>span{min-width:0;overflow-wrap:anywhere}
.cn-icon-list .code{white-space:normal;overflow-wrap:anywhere}
.cn-endpoint-port{white-space:nowrap}
.cn-endpoint-scroll{max-width:100%;overflow-x:auto;outline-offset:3px}
.cn-endpoint-scroll:focus-visible{outline:2px solid var(--running)}
.cn-endpoint-scroll>.tbl-wrap{overflow:visible}
@media(min-width:761px){
[data-page="connections"] #p-endpoints .tbl{min-width:820px}
[data-page="connections"] #p-endpoints .tbl th:nth-child(1){width:150px}
[data-page="connections"] #p-endpoints .tbl th:nth-child(2){width:270px}
[data-page="connections"] #p-endpoints .tbl th:nth-child(3){width:120px}
[data-page="connections"] #p-endpoints .tbl td:nth-child(2) .code,[data-page="connections"] #p-endpoints .tbl td:nth-child(3){white-space:nowrap;overflow-wrap:normal}
}
.cn-slots{display:inline-block;vertical-align:middle;max-width:96px;flex-shrink:0}
.cn-slot-used{fill:var(--running)}
.cn-slot-free{fill:none;stroke:var(--line-strong);stroke-width:1.2}
.cn-endpoint-hosts{list-style:none;padding:0;margin:4px 0 0;display:grid;gap:8px}
.cn-endpoint-hosts small{display:block;color:var(--ink-muted);font-size:11px}
.cn-hook-scroll{overflow-x:auto}
.cn-hook-scroll>.tbl-wrap{overflow:visible}
[data-page="connections"] #p-notify .tbl th,[data-page="connections"] #p-notify .tbl td{padding-left:8px;padding-right:8px}
[data-page="connections"] #p-notify .tbl th{overflow-wrap:normal;word-break:normal}
[data-page="connections"] #p-notify .tbl th:first-child{width:76px;min-width:76px}
[data-page="connections"] #p-notify .tbl{table-layout:auto}
[data-page="connections"] #p-notify .tbl td:first-child,[data-page="connections"] #p-notify .tbl td:first-child a{white-space:nowrap;overflow-wrap:normal;word-break:normal}
.cn-list{padding-left:18px;display:grid;gap:12px}
@media(min-width:761px){[data-page="connections"] #p-forges .cn-forge-config .tbl{min-width:780px}}
@media(max-width:760px){[data-page="connections"] #p-forges .cn-forge-config .tbl--stack tr{grid-template-columns:minmax(0,1fr) minmax(0,2fr)}}
@media(max-width:1000px){.connections-layout{grid-template-columns:minmax(0,1fr)}}
`;
