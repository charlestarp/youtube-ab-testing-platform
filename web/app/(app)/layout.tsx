"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useUser } from "@/lib/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { UpdateBanner } from "@/components/update-banner";
import { AppSwitcher } from "@/components/app-switcher";
import { GoToSearch } from "@/components/go-to-search";

const navGroups: {
  label: string;
  items: { href: string; label: string; icon: () => React.ReactElement; adminOnly?: boolean }[];
}[] = [
  {
    label: "Test",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: DashboardIcon },
      { href: "/tests", label: "Tests", icon: TestIcon },
      { href: "/retests", label: "Retests", icon: RetestIcon },
      { href: "/schedule", label: "Schedule", icon: CalendarIcon },
      { href: "/videos", label: "Videos", icon: VideoIcon },
    ],
  },
  {
    label: "Learn",
    items: [
      { href: "/growth", label: "Growth", icon: InsightsIcon },
      { href: "/what-works", label: "What works", icon: LearnedIcon },
      { href: "/learned", label: "What we've learned", icon: LearnedIcon },
      { href: "/insights", label: "Insights", icon: InsightsIcon },
      { href: "/tag-analytics", label: "Tag Analytics", icon: TagIcon },
      { href: "/retention-spikes", label: "Retention Spikes", icon: SpikesIcon },
      { href: "/competitors", label: "Competitors", icon: UsersIcon },
    ],
  },
  {
    label: "Listen",
    items: [
      { href: "/listening", label: "Comments", icon: EarIcon },
      { href: "/ai-chat", label: "Ask AI", icon: ChatIcon },
    ],
  },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading, isLoggedIn, isError, logout } = useUser();
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isLoading && (!isLoggedIn || isError)) {
      router.push("/login");
    }
  }, [isLoading, isLoggedIn, isError, router]);

  // Close user menu on click-outside (mirrors AppSwitcher)
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Close sidebar on navigation
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  // Activity log: beacon each page view so admins can see where people are.
  useEffect(() => {
    if (!isLoggedIn) return;
    fetch("/api/activity/view", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: pathname }) }).catch(() => {});
  }, [pathname, isLoggedIn]);

  // Fleet feedback widget (served by TARP Command). Cache-busts each minute.
  useEffect(() => {
    if (document.getElementById("tf-widget-script")) return;
    const s = document.createElement("script");
    s.id = "tf-widget-script";
    s.src = "https://home.example.com/feedback-widget.js?v=" + Math.floor(Date.now() / 60000);
    s.async = true;
    s.setAttribute("data-app", "testing");
    s.setAttribute("data-color", "#FB65BE");
    document.body.appendChild(s);
  }, []);

  if (isLoading || (!isLoggedIn && !isError)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  if (!isLoggedIn || isError) {
    return null;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <UpdateBanner />
      {/* Mobile header */}
      <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-4 py-2.5 bg-sidebar border-b border-sidebar-border md:hidden">
        <Link href="/dashboard" className="font-display text-lg font-extrabold tracking-tight">
          YT Testing
        </Link>
        <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-1.5 text-muted-foreground hover:text-foreground">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" x2="21" y1="6" y2="6"/><line x1="3" x2="21" y1="12" y2="12"/><line x1="3" x2="21" y1="18" y2="18"/></svg>
        </button>
      </div>

      {/* Sidebar overlay on mobile */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`fixed md:static inset-y-0 left-0 z-40 w-56 border-r border-sidebar-border bg-sidebar flex flex-col shrink-0 transition-transform md:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="px-4 h-14 hidden md:flex items-center gap-2.5">
          <span style={{ width: 9, height: 9, borderRadius: 999, backgroundColor: "#FB65BE", flexShrink: 0 }} />
          <Link href="/dashboard" className="font-display text-lg font-extrabold tracking-tight leading-none">
            YT Testing
          </Link>
          <div className="ml-auto"><AppSwitcher current="testing" /></div>
        </div>
        <div className="h-11 md:hidden" /> {/* spacer for mobile header */}

        <nav className="flex-1 overflow-y-auto px-2 pb-2 space-y-4">
          {navGroups.map((group) => {
            const items = group.items.filter((item) => !item.adminOnly || user?.role === "admin");
            if (items.length === 0) return null;
            return (
              <div key={group.label} className="space-y-0.5">
                <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {group.label}
                </p>
                {items.map(({ href, label, icon: Icon }) => {
                  const active = pathname === href || pathname.startsWith(href + "/");
                  return (
                    <Link
                      key={href}
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] transition-colors ${
                        active
                          ? "bg-sidebar-accent text-foreground font-medium"
                          : "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
                      }`}
                    >
                      <Icon />
                      {label}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="px-3 py-3 border-t border-sidebar-border">
          <div ref={userMenuRef} className="relative">
            <button
              onClick={() => setUserMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              className="w-full flex items-center gap-2 px-1.5 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors"
            >
              {user?.avatar && (
                <img src={user.avatar} alt="" className="w-6 h-6 rounded-full shrink-0" />
              )}
              <span className="text-xs truncate flex-1 text-left">{user?.name}</span>
              <ChevronUpDownIcon />
            </button>
            {userMenuOpen && (
              <div className="absolute bottom-11 left-0 right-0 z-[60] p-1.5 rounded-xl bg-card border border-border shadow-xl">
                {user?.role === "admin" && (
                  <Link
                    href="/admin"
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-[13px] font-medium text-foreground hover:bg-sidebar-accent"
                  >
                    <AdminIcon />
                    Admin
                  </Link>
                )}
                <button
                  onClick={() => { setUserMenuOpen(false); logout(); }}
                  className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-[13px] font-medium text-foreground hover:bg-sidebar-accent"
                >
                  <LogOutIcon />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-12 shrink-0 border-b border-sidebar-border bg-sidebar flex items-center gap-3 px-4 md:px-6">
          <GoToSearch />
          <div className="ml-auto"><ThemeToggle /></div>
        </header>
        <main className="flex-1 overflow-auto pt-11 md:pt-0">
        {/* Impersonation banner */}
        {(user as any)?.impersonated_by && (
          <div className="bg-amber-500 text-black px-4 py-1.5 text-xs font-medium flex items-center justify-between">
            <span>Viewing as {user?.name} (impersonated by {(user as any).impersonated_by})</span>
            <button
              onClick={async () => {
                await fetch("/api/admin/stop-impersonation", { method: "POST", credentials: "include" });
                window.location.reload();
              }}
              className="px-2 py-0.5 bg-black/20 rounded text-[10px] hover:bg-black/30"
            >
              Stop
            </button>
          </div>
        )}
        {children}
        </main>
      </div>
    </div>
  );
}

// Inline SVG icons (matching TARPGPT pattern)
function DashboardIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>;
}
function TestIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16.5h10"/></svg>;
}
function CalendarIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>;
}
function VideoIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17"/><path d="m10 15 5-3-5-3z"/></svg>;
}
function LearnedIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>;
}
function InsightsIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/></svg>;
}
function TagIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/></svg>;
}
function SpikesIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 17 7 11 11 15 15 7 19 13 21 10"/></svg>;
}
function UsersIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
}
function EarIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0"/><path d="M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"/></svg>;
}
function ChatIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 21 1.9-5.7a8.5 8.5 0 1 1 3.8 3.8z"/></svg>;
}
function AdminIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>;
}
function RetestIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>;
}
function ChevronUpDownIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>;
}
function LogOutIcon() {
  return <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>;
}
