"use client";

import { useState, useEffect, useRef } from "react";
import useSWR from "swr";
import { tags as tagsApi, tagCategories as catApi, type ThumbnailTag, type TagCategory } from "@/lib/api";

interface TagSelectorProps {
  testId: number;
  variantId: number;
  initialTags: ThumbnailTag[];
  onTagsChange?: (tags: ThumbnailTag[]) => void;
  compact?: boolean;
  showCompleteness?: boolean;
}

export function TagSelector({ testId, variantId, initialTags, onTagsChange, compact, showCompleteness = true }: TagSelectorProps) {
  const [currentTags, setCurrentTags] = useState<ThumbnailTag[]>(initialTags);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: allTags, mutate: mutateTags } = useSWR(open ? "all-tags" : null, () => tagsApi.list());
  const { data: categories } = useSWR(open ? "tag-cats-selector" : null, () => catApi.list());

  useEffect(() => { setCurrentTags(initialTags); }, [initialTags]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const filtered = (allTags || []).filter(t =>
    !search || t.name.includes(search.toLowerCase())
  );
  const isTagged = (tagId: number) => currentTags.some(t => t.id === tagId);

  const toggleTag = async (tag: ThumbnailTag) => {
    if (isTagged(tag.id)) {
      await tagsApi.removeFromVariant(testId, variantId, tag.id);
      const next = currentTags.filter(t => t.id !== tag.id);
      setCurrentTags(next);
      onTagsChange?.(next);
    } else {
      await tagsApi.addToVariant(testId, variantId, tag.name);
      const next = [...currentTags, tag];
      setCurrentTags(next);
      onTagsChange?.(next);
    }
  };

  const createAndAdd = async () => {
    if (!search.trim() || creating) return;
    setCreating(true);
    try {
      const res = await tagsApi.addToVariant(testId, variantId, search.trim());
      if (res.tag) {
        const next = [...currentTags, res.tag];
        setCurrentTags(next);
        onTagsChange?.(next);
        mutateTags();
      }
      setSearch("");
    } finally {
      setCreating(false);
    }
  };

  const exactMatch = filtered.some(t => t.name === search.trim().toLowerCase());

  // Completeness: which categories are covered?
  const taggedCategories = new Set(currentTags.map(t => t.category).filter(Boolean));
  const allCategoryNames = (categories || []).map(c => c.name).filter(n => n !== "other");
  const missingCategories = allCategoryNames.filter(c => !taggedCategories.has(c));
  const completeness = allCategoryNames.length > 0 ? taggedCategories.size : 0;
  const totalCats = allCategoryNames.length;

  // Group tags by category for dropdown
  const grouped: { name: string; color: string; tags: typeof filtered }[] = [];
  if (categories && filtered.length > 0) {
    for (const cat of categories) {
      const catTags = filtered.filter(t => t.category === cat.name);
      if (catTags.length > 0) grouped.push({ name: cat.name, color: cat.color, tags: catTags });
    }
    const uncategorized = filtered.filter(t => !t.category || !categories.some(c => c.name === t.category));
    if (uncategorized.length > 0) grouped.push({ name: "other", color: "#666", tags: uncategorized });
  }

  return (
    <div ref={ref} className="relative">
      {/* Display tags */}
      <div className="flex flex-wrap gap-1 items-center">
        {currentTags.map(tag => {
          const isAi = tag.source === "ai";
          return (
          <span
            key={tag.id}
            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-medium text-white cursor-pointer hover:opacity-80 ${isAi ? "border border-dashed border-white/70" : ""}`}
            style={{ backgroundColor: tag.color || "#6b7280" }}
            onClick={(e) => { e.stopPropagation(); toggleTag(tag); }}
            title={isAi ? `Auto-tagged by AI. Click to remove "${tag.name}"` : `Remove "${tag.name}"`}
          >
            {isAi && (
              <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6z"/></svg>
            )}
            {tag.name}
            <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l6 6M9 3l-6 6"/></svg>
          </span>
          );
        })}
        <button
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-medium border border-dashed border-muted-foreground/40 text-muted-foreground hover:border-primary hover:text-primary"
        >
          <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 2v8M2 6h8"/></svg>
          tag
        </button>
        {showCompleteness && totalCats > 0 && currentTags.length > 0 && (
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${completeness >= totalCats ? "bg-green-500/15 text-green-400" : completeness > 0 ? "bg-yellow-500/15 text-yellow-400" : "bg-muted text-muted-foreground"}`}>
            {completeness}/{totalCats}
          </span>
        )}
      </div>

      {/* Missing categories hint */}
      {showCompleteness && missingCategories.length > 0 && currentTags.length > 0 && (
        <p className="text-[8px] text-muted-foreground/60 mt-0.5">
          Missing: {missingCategories.join(", ")}
        </p>
      )}

      {/* Dropdown */}
      {open && (
        <div className="absolute z-30 top-full left-0 mt-1 bg-popover border border-border rounded-lg shadow-xl p-2 min-w-[220px] max-w-[280px]" onClick={e => e.stopPropagation()}>
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !exactMatch && search.trim()) createAndAdd(); }}
            placeholder="Search or create tag..."
            className="w-full px-2 py-1 text-xs bg-background border border-border rounded mb-1.5 outline-none focus:border-primary"
          />
          <div className="max-h-[200px] overflow-y-auto space-y-1">
            {grouped.length > 0 ? grouped.map(group => (
              <div key={group.name}>
                <div className="flex items-center gap-1.5 px-2 py-1">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: group.color }} />
                  <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{group.name}</span>
                </div>
                {group.tags.map(tag => (
                  <button
                    key={tag.id}
                    onClick={() => toggleTag(tag)}
                    className={`w-full text-left px-2 py-1 text-xs rounded flex items-center gap-2 hover:bg-accent ml-1 ${isTagged(tag.id) ? "bg-accent/50" : ""}`}
                  >
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: tag.color || "#7c63ff" }} />
                    <span className="truncate">{tag.name}</span>
                    {isTagged(tag.id) && <svg className="ml-auto shrink-0" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 6l3 3 5-5"/></svg>}
                  </button>
                ))}
              </div>
            )) : filtered.map(tag => (
              <button
                key={tag.id}
                onClick={() => toggleTag(tag)}
                className={`w-full text-left px-2 py-1 text-xs rounded flex items-center gap-2 hover:bg-accent ${isTagged(tag.id) ? "bg-accent/50" : ""}`}
              >
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: tag.color || "#7c63ff" }} />
                <span className="truncate">{tag.name}</span>
                {isTagged(tag.id) && <svg className="ml-auto shrink-0" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 6l3 3 5-5"/></svg>}
              </button>
            ))}
          </div>
          {search.trim() && !exactMatch && (
            <button
              onClick={createAndAdd}
              disabled={creating}
              className="w-full text-left px-2 py-1.5 text-xs text-primary hover:bg-accent rounded mt-1 border-t border-border pt-1.5 flex items-center gap-1.5"
            >
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 2v8M2 6h8"/></svg>
              Create "{search.trim()}"
            </button>
          )}
          {!search && filtered.length === 0 && (
            <p className="text-[10px] text-muted-foreground px-2 py-2">No tags yet. Type to create one.</p>
          )}
        </div>
      )}
    </div>
  );
}
