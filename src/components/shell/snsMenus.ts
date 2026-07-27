export type SnsMenuItem = {
  id: "naver" | "threads" | "instagram";
  name: string;
  enabled: boolean;
  href?: string;
  comingSoonMessage: string;
};

export const snsMenus: SnsMenuItem[] = [
  {
    id: "naver",
    name: "네이버 블로그",
    enabled: true,
    href: "/admin/discovery",
    comingSoonMessage: "네이버 블로그 자동화 기능은 준비 중입니다.",
  },
  {
    id: "threads",
    name: "Threads",
    enabled: false,
    comingSoonMessage: "Threads 자동화 기능은 준비 중입니다.",
  },
  {
    id: "instagram",
    name: "Instagram",
    enabled: false,
    comingSoonMessage: "Instagram 자동화 기능은 준비 중입니다.",
  },
];

export type AppNavItem = {
  href: string;
  label: string;
  match: (pathname: string) => boolean;
};

/** Primary app pages (PC sidebar) */
export const appNav: AppNavItem[] = [
  {
    href: "/today",
    label: "오늘",
    match: (p) => p === "/today" || p.startsWith("/today/"),
  },
  {
    href: "/neighbors",
    label: "이웃",
    match: (p) => p.startsWith("/neighbors"),
  },
  {
    href: "/more",
    label: "더보기",
    match: (p) => p.startsWith("/more"),
  },
];

/** Naver-scoped admin section links */
export const naverAdminNav: AppNavItem[] = [
  {
    href: "/admin/discovery",
    label: "Discovery",
    match: (p) => p.startsWith("/admin/discovery"),
  },
  {
    href: "/admin/actions",
    label: "Actions",
    match: (p) => p.startsWith("/admin/actions"),
  },
  {
    href: "/admin/neighbors",
    label: "Neighbors",
    match: (p) => p.startsWith("/admin/neighbors"),
  },
];

export const ADMIN_CONTENT_CLASS =
  "mx-auto flex w-full max-w-lg flex-col gap-5 px-4 pb-28 pt-6 md:max-w-5xl md:px-8 md:pb-12";
