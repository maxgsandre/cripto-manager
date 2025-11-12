import React from 'react';

export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-end gap-3 sm:gap-4 mb-4 p-3 sm:p-4 bg-white/5 rounded-lg border border-white/10">{children}</div>;
}


