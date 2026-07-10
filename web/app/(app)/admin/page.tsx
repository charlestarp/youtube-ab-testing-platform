"use client";

import { useState } from "react";
import useSWR from "swr";
import { admin, dataIntegrity } from "@/lib/api";
import { useUser } from "@/lib/auth";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

const roleColors: Record<string, string> = {
  admin: "bg-primary/20 text-primary border-primary/30",
  editor: "bg-blue-500/20 text-info border-blue-500/30",
  viewer: "bg-muted text-muted-foreground border-border",
};

export default function AdminPage() {
  const { user } = useUser();
  const [tab, setTab] = useState<"activity" | "users" | "invites" | "quota" | "data">("activity");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");
  const [inviting, setInviting] = useState(false);
  const [lastInviteUrl, setLastInviteUrl] = useState("");

  const { data: users, mutate: mutateUsers } = useSWR("admin-users", admin.users);
  const { data: invites, mutate: mutateInvites } = useSWR(tab === "invites" ? "admin-invites" : null, admin.invites);
  const { data: quota } = useSWR(tab === "quota" ? "admin-quota" : null, admin.quota);
  const { data: integrity } = useSWR(tab === "data" ? "data-integrity" : null, dataIntegrity.get);
  const { data: activity } = useSWR(tab === "activity" ? "admin-activity" : null, admin.activity, { refreshInterval: 15000 });
  const [actFilter, setActFilter] = useState<"all" | "actions">("actions");

  if (user?.role !== "admin") {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          Admin access required.
        </div>
      </div>
    );
  }

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      const result = await admin.invite(inviteEmail.trim(), inviteRole);
      setLastInviteUrl(result.invite_url);
      setInviteEmail("");
      mutateInvites();
    } catch (err: any) {
      alert(err.message);
    }
    setInviting(false);
  };

  const handleRoleChange = async (userId: number, role: string) => {
    await admin.updateUser(userId, { role });
    mutateUsers();
  };

  const handleDeleteUser = async (userId: number) => {
    if (!confirm("Remove this user?")) return;
    await admin.deleteUser(userId);
    mutateUsers();
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-5">
      <h1 className="text-2xl font-bold">Admin</h1>

      <div className="flex flex-wrap gap-1">
        {(["activity", "users", "invites", "quota", "data"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1 rounded-md text-xs font-medium capitalize transition-colors ${
              tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"
            }`}
          >
            {t === "data" ? "Data health" : t}
          </button>
        ))}
      </div>

      {/* Activity */}
      {tab === "activity" && activity && (
        <div className="space-y-5">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="relative flex size-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-green opacity-75" /><span className="relative inline-flex rounded-full size-2 bg-brand-green" /></span>
              <h3 className="font-semibold text-sm">Online now ({activity.online.length})</h3>
            </div>
            {activity.online.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nobody active in the last 5 minutes.</p>
            ) : (
              <div className="flex flex-wrap gap-3">
                {activity.online.map((u: any) => (
                  <div key={u.id} className="flex items-center gap-2 text-sm">
                    {u.avatar ? <img src={u.avatar} alt="" className="size-6 rounded-full" /> : <span className="size-6 rounded-full bg-muted grid place-items-center text-[10px]">{(u.name || "?")[0]}</span>}
                    <span>{u.name || u.email}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h3 className="font-semibold text-sm">Recent activity</h3>
              <div className="inline-flex rounded-lg border border-border p-0.5 text-xs">
                {(["actions", "all"] as const).map((f) => (
                  <button key={f} onClick={() => setActFilter(f)} className={`px-2.5 py-1 rounded-md font-medium capitalize transition-colors ${actFilter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                    {f === "all" ? "All (incl. page views)" : "Actions"}
                  </button>
                ))}
              </div>
            </div>
            <ul className="divide-y divide-border">
              {activity.activity.filter((a: any) => actFilter === "all" || a.action !== "page_view").map((a: any) => {
                const cls = a.action === "login" ? "bg-brand-blue/15 text-info"
                  : /completed|created|autotag|retag/.test(a.action) ? "bg-brand-green/15 text-pos"
                  : /deleted/.test(a.action) ? "bg-brand-red/15 text-neg"
                  : a.action === "page_view" ? "bg-muted/50 text-muted-foreground"
                  : "bg-muted text-muted-foreground";
                return (
                  <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                    <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${cls}`}>{a.action.replace(/_/g, " ")}</span>
                    <span className="font-medium shrink-0">{a.user_name || a.email || "someone"}</span>
                    <span className="flex-1 min-w-0 truncate text-muted-foreground">{a.detail || ""}</span>
                    <span className="text-xs text-muted-foreground shrink-0 ml-auto">{new Date(a.created_at + "Z").toLocaleString()}</span>
                  </li>
                );
              })}
              {activity.activity.length === 0 && <li className="py-4 text-sm text-muted-foreground text-center">No activity recorded yet.</li>}
            </ul>
          </div>
        </div>
      )}

      {/* Users */}
      {tab === "users" && (
        <div className="space-y-2">
          {users?.map((u: any) => (
            <div key={u.id} className="bg-card border border-border rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                {u.avatar && <img src={u.avatar} alt="" className="w-8 h-8 rounded-full shrink-0" />}
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{u.name}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{u.email}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <select
                  value={u.role}
                  onChange={(e) => handleRoleChange(u.id, e.target.value)}
                  disabled={u.id === user?.id}
                  className="h-7 rounded border border-input bg-transparent px-2 text-xs"
                >
                  <option value="admin">Admin</option>
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${roleColors[u.role] || roleColors.viewer}`}>
                  {u.role}
                </span>
                {u.id !== user?.id && (
                  <button
                    onClick={async () => { await admin.impersonate(u.id); window.location.reload(); }}
                    className="text-[10px] text-muted-foreground border border-border rounded px-2 py-0.5 hover:bg-accent"
                  >
                    View as
                  </button>
                )}
                {u.id !== user?.id && (
                  <button
                    onClick={() => handleDeleteUser(u.id)}
                    className="text-[10px] text-neg border border-red-500/30 rounded px-2 py-0.5 hover:bg-red-500/10"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Invites */}
      {tab === "invites" && (
        <div className="space-y-4">
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <p className="text-sm font-medium">Send Invite</p>
            <div className="flex flex-wrap gap-2">
              <input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleInvite(); }}
                placeholder="Email address..."
                className="flex-1 min-w-[160px] h-8 rounded-md border border-input bg-transparent px-3 text-sm placeholder:text-muted-foreground"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="admin">Admin</option>
              </select>
              <button
                onClick={handleInvite}
                disabled={inviting || !inviteEmail.trim()}
                className="px-4 h-8 bg-primary text-primary-foreground rounded-md text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                {inviting ? "Sending..." : "Send Invite"}
              </button>
            </div>
            {lastInviteUrl && (
              <div className="bg-muted/30 border border-border rounded-lg p-3">
                <p className="text-[10px] text-muted-foreground mb-1">Invite link (also emailed):</p>
                <p className="text-xs font-mono break-all text-primary">{lastInviteUrl}</p>
              </div>
            )}
          </div>

          <div className="space-y-2">
            {invites?.map((i: any) => (
              <div key={i.id} className="bg-card border border-border rounded-xl px-4 py-2.5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm truncate">{i.email}</p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span>Invited by {i.invited_by_name}</span>
                    <span>Role: {i.role}</span>
                    <span>{new Date(i.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {i.used_at ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/15 text-pos">Accepted</span>
                  ) : (
                    <>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/15 text-warn">Pending</span>
                      <button
                        onClick={async () => { await admin.revokeInvite(i.id); mutateInvites(); }}
                        className="text-[10px] text-neg border border-red-500/30 rounded px-2 py-0.5 hover:bg-red-500/10"
                      >
                        Revoke
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {(!invites || invites.length === 0) && (
              <div className="bg-card border border-border rounded-xl p-6 text-center text-sm text-muted-foreground">
                No invites sent yet.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Quota */}
      {tab === "quota" && quota && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="bg-card border border-border rounded-xl p-3">
              <p className="text-2xl font-bold">{quota.today?.total?.toLocaleString()}</p>
              <p className="text-[10px] text-muted-foreground">Units Used Today</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-3">
              <p className={`text-2xl font-bold ${quota.today?.remaining < 2000 ? 'text-neg' : 'text-pos'}`}>
                {quota.today?.remaining?.toLocaleString()}
              </p>
              <p className="text-[10px] text-muted-foreground">Remaining (of 10,000)</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-3">
              <div className="w-full bg-muted rounded-full h-3 mt-1">
                <div
                  className={`h-3 rounded-full ${quota.today?.total > 8000 ? 'bg-red-500' : quota.today?.total > 5000 ? 'bg-yellow-500' : 'bg-green-500'}`}
                  style={{ width: `${Math.min(100, (quota.today?.total / 10000) * 100)}%` }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">{((quota.today?.total / 10000) * 100).toFixed(1)}% used</p>
            </div>
          </div>

          {quota.today?.breakdown?.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4">
              <h3 className="text-sm font-semibold mb-3">Today's Breakdown</h3>
              <div className="space-y-1.5">
                {quota.today.breakdown.map((b: any) => (
                  <div key={b.action} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground font-mono">{b.action}</span>
                    <span>{b.units} units ({b.count} calls)</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {quota.history?.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4">
              <h3 className="text-sm font-semibold mb-3">Daily Usage (Last 14 Days)</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={quota.history}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="date" tick={{ fill: "#888", fontSize: 10 }} tickFormatter={(d: string) => d.slice(5)} />
                  <YAxis tick={{ fill: "#888", fontSize: 10 }} />
                  <Tooltip contentStyle={{ backgroundColor: "#1a1612", border: "1px solid #2d2519", fontSize: 12 }} />
                  <Bar dataKey="units" fill="#7c63ff" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {tab === "data" && integrity && (
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground max-w-2xl">
            Measurement quality checks. These rows are already excluded from all analysis, this is just so you can see what was caught and why. Impossible CTR (over 25%) and legacy baseline-only tests were the cause of the old inflated numbers.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Completed tests", value: integrity.summary.completed_tests, tone: "" },
              { label: "No real data", value: integrity.summary.tests_no_real_data, tone: "text-warn" },
              { label: "Suspect rows", value: integrity.summary.suspect_rows, tone: "text-neg" },
              { label: "Legacy rows", value: integrity.summary.legacy_baseline_rows, tone: "text-muted-foreground" },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-border bg-card p-4">
                <div className={`font-display text-2xl font-extrabold ${s.tone || "text-foreground"}`}>{s.value}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="font-semibold text-sm mb-2">Tests with no usable data ({integrity.no_real_data.length})</h3>
            <p className="text-xs text-muted-foreground mb-3">Early tests that only have the old baseline format. They now show insufficient data instead of made-up numbers.</p>
            <ul className="divide-y divide-border">
              {integrity.no_real_data.map((t) => (
                <li key={t.test_id} className="flex items-center gap-3 py-2 text-sm">
                  <a href={`/tests/${t.test_id}`} className="text-info hover:underline shrink-0">#{t.test_id}</a>
                  <span className="flex-1 truncate">{t.video_title || "Untitled"}</span>
                  <span className="text-xs text-muted-foreground shrink-0">{t.completed_at?.slice(0, 10)}</span>
                </li>
              ))}
              {integrity.no_real_data.length === 0 && <li className="py-2 text-sm text-muted-foreground">None.</li>}
            </ul>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="font-semibold text-sm mb-2">Suspect measurement rows ({integrity.suspect_rows.length})</h3>
            <p className="text-xs text-muted-foreground mb-3">Individual slots with physically impossible numbers, excluded from totals.</p>
            <ul className="divide-y divide-border">
              {integrity.suspect_rows.map((r, i) => (
                <li key={i} className="flex items-center gap-3 py-2 text-sm">
                  <a href={`/tests/${r.test_id}`} className="text-info hover:underline shrink-0">#{r.test_id}</a>
                  <span className="shrink-0 text-muted-foreground">{r.variant_label}</span>
                  <span className="flex-1 text-xs text-neg">{r.reason}</span>
                  <span className="text-xs text-muted-foreground shrink-0 tabular-nums">{r.impressions.toLocaleString()} imp / {r.views.toLocaleString()} views</span>
                </li>
              ))}
              {integrity.suspect_rows.length === 0 && <li className="py-2 text-sm text-muted-foreground">None.</li>}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
