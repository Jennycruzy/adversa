import React from 'react';

export function OfflineControls({
  offline,
  onToggle,
}: {
  offline: boolean;
  onToggle: (offline: boolean) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onToggle(!offline)}
      className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-100 hover:bg-zinc-900"
      aria-pressed={offline}
    >
      {offline ? 'Restore Internet' : 'Kill Internet'}
    </button>
  );
}
