import type { ReactNode } from "react";

interface Column<T> {
  key: keyof T & string;
  header: string;
  render?: (row: T) => ReactNode;
}

interface Props<T> {
  rows: T[];
  columns: Column<T>[];
  onRowClick?: (row: T) => void;
}

export function DataTable<T extends { id: string }>({ rows, columns, onRowClick }: Props<T>) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-border text-left text-muted">
          {columns.map((c) => (
            <th key={c.key} className="px-3 py-2 font-medium">
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id}
            className="border-b border-border last:border-0 hover:bg-surface cursor-pointer"
            onClick={() => onRowClick?.(row)}
          >
            {columns.map((c) => (
              <td key={c.key} className="px-3 py-2">
                {c.render ? c.render(row) : String(row[c.key] ?? "")}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
