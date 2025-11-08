import React from 'react';

export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-end gap-4 mb-4 p-4 bg-white/5 rounded-lg border border-white/10">{children}</div>;
}


