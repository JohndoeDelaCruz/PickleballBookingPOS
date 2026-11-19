"use client";

import Link from "next/link";
import { useState } from "react";

const defaultPageSize = 10;

export function useTablePage(count: number, resetKey?: string, pageSize = defaultPageSize) {
  const [selection, setSelection] = useState({ resetKey, page: 1 });
  const pageCount = Math.max(1, Math.ceil(count / pageSize));
  const page = selection.resetKey === resetKey ? Math.min(selection.page, pageCount) : 1;
  if (selection.resetKey !== resetKey || selection.page !== page)
    setSelection({ resetKey, page });

  return {
    count,
    page,
    pageSize,
    start: (page - 1) * pageSize,
    end: page * pageSize,
    onPageChange: (page: number) => setSelection({ resetKey, page }),
  };
}

type TablePaginationProps = {
  label: string;
  count: number;
  page: number;
  pageSize: number;
  showSinglePage?: boolean;
  anchorId?: string;
} & (
  | { onPageChange: (page: number) => void; href?: never }
  | { href: (page: number) => string; onPageChange?: never }
);

export function TablePagination({ label, count, page, pageSize, showSinglePage = false, anchorId, onPageChange, href }: TablePaginationProps) {
  const pageCount = Math.ceil(count / pageSize);
  if (pageCount === 0 || (pageCount === 1 && !showSinglePage)) return null;

  function control(text: string, nextPage: number) {
    const available = nextPage >= 1 && nextPage <= pageCount;
    const className = "button button-small";
    if (href && available) return <Link className={className} href={href(nextPage)}>{text}</Link>;
    return (
      <button type="button" className={className} disabled={!available}
        onClick={() => {
          onPageChange?.(nextPage);
          const anchor = anchorId && document.getElementById(anchorId);
          if (anchor) {
            anchor.focus({ preventScroll: true });
            anchor.scrollIntoView({ block: "start", behavior: "instant" });
          }
        }}>
        {text}
      </button>
    );
  }

  return (
    <nav className="table-pagination" aria-label={label}>
      <span role="status">Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, count)} of {count}</span>
      <div className="table-pagination-controls">
        {control("Previous", page - 1)}
        <span>Page {page} of {pageCount}</span>
        {control("Next", page + 1)}
      </div>
    </nav>
  );
}
