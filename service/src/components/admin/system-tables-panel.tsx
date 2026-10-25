import { Metric, PanelError, SystemPanel } from "@/components/admin/system-panel";
import type { Section, TableCounts } from "@/lib/admin/system";

const ROWS: { key: keyof TableCounts; label: string; hint: string }[] = [
  { key: "accounts", label: "accounts", hint: "论坛身份（OAuth2）" },
  { key: "products", label: "products", hint: "全部产品" },
  { key: "releaseVersions", label: "release_versions", hint: "含候选与已下架" },
  { key: "releaseAssets", label: "release_assets", hint: "版本 × 平台" },
  { key: "assets", label: "assets", hint: "内容寻址图片" },
  { key: "auditLog", label: "audit_log", hint: "管理动作记录" },
];

/** Row counts in one aggregate statement — the page must not fan out per table. */
export function SystemTablesPanel({ data }: { data: Section<TableCounts> }) {
  return (
    <SystemPanel id="tables" title="表计数" hint="单条聚合查询">
      {data.ok ? (
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {ROWS.map((row) => (
            <Metric
              key={row.key}
              label={row.label}
              value={data.value[row.key].toLocaleString("zh-CN")}
              hint={row.hint}
              mono
            />
          ))}
        </dl>
      ) : (
        <PanelError label="表计数" message={data.error} />
      )}
    </SystemPanel>
  );
}
