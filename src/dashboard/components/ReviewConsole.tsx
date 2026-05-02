import React, { useState } from 'react';

export function ReviewConsole({
  onSubmit,
}: {
  onSubmit: (prUrl: string) => Promise<void> | void;
}): React.JSX.Element {
  const [prUrl, setPrUrl] = useState('');

  return (
    <form
      className="flex gap-2"
      onSubmit={event => {
        event.preventDefault();
        if (prUrl.trim()) void onSubmit(prUrl.trim());
      }}
    >
      <input
        value={prUrl}
        onChange={event => setPrUrl(event.currentTarget.value)}
        placeholder="https://github.com/owner/repo/pull/42"
        className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
      />
      <button type="submit" className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-zinc-950">
        Review
      </button>
    </form>
  );
}
