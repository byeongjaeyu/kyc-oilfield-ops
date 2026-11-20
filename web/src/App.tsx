import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AdminConsole } from './AdminConsole';
import { ContractSection } from './ContractSection';
import { Counter } from './Counter';
import { resetDemoData } from './demo/client';
import { useSiteConfig } from './Donate';
import { getJSON, md } from './data';
import { FeedbackSection } from './FeedbackSection';
import { FuelSection } from './FuelSection';
import { InspectionSection } from './InspectionSection';
import { Led } from './Led';
import { LandSection } from './LandSection';
import { Landing } from './Landing';
import { MarketBoard, MarketSection } from './Market';
import { Onboarding } from './Onboarding';
import { PaymentSection } from './PaymentSection';
import { PriceSection } from './PriceSection';
import { Preview } from './Preview';
import { StationSettings } from './StationSettings';
import { SupplySection } from './SupplySection';
import { Tour, stationSteps, type TourStep } from './Tour';
import { activity, exitDemo, isDemo, markActivity, ROLE_KO, supabase, type Area, type Membership, type Perms, type Profile, type Role, type Station } from './supabase';
import type { LandLatest, MarketLatest, PolicyIndexEntry, PolicyItem, PolicyReport, PriceHistoryEntry, PriceLatest } from './types';
import { Loading } from './Loading';
import { PasswordSheet, useHasPassword } from './PasswordSheet';
import { LegalPage, type LegalKind } from './Legal';
import { ChatButton, ChatPanel } from './ChatPanel';

/** 폴사인 아래 보조 간판 = 탭. 선택된 간판에 불이 들어온다 */
const TABS = [
  { id: 'prices', name: '가격 비교' },
  { id: 'fuel', name: '유류 장부' },
  { id: 'supplies', name: '소모품' },
  { id: 'inspection', name: '법정 검사' },
  { id: 'policy', name: '정책 요약' },
  { id: 'land', name: '부지 가치' },
  { id: 'contract', name: '계약 일정' },
  { id: 'payment', name: '입금 확인' },
] as const;
/** 임대 중일 때만 있는 메뉴 */
/** 임대 중일 때만 보이는 탭 (계약 일정은 공급·렌탈 계약도 있어 늘 보임) */
const LEASE_TABS: readonly string[] = ['payment'];
type TabId = (typeof TABS)[number]['id'] | 'settings' | 'feedback' | 'counter';

/** 탭 → 권한 영역. null 이면 영역과 무관 (주유소 설정은 관리자, 의견은 누구나) */
const TAB_AREA: Record<TabId, Area | null> = {
  prices: 'prices',
  land: 'land',
  policy: 'policy',
  inspection: 'inspections',
  contract: 'contracts',
  payment: 'payments',
  supplies: 'supplies',
  fuel: 'fuel',
  settings: null,
  feedback: null,
  counter: null,
};

const tabFromHash = (allowed: readonly TabId[]): TabId => {
  const h = window.location.hash.slice(1) as TabId;
  return allowed.includes(h) ? h : allowed[0];
};

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 저장 못 해도 동작에는 지장 없음 */
    }
  },
};

/** "한빛주유소 북구점" → 간판 큰 글씨 "한빛주유소" + 작은 글씨 "북구점" */
const splitName = (name: string) => {
  const [head, ...rest] = name.trim().split(/\s+/);
  return { head: head || name, tail: rest.join(' ') };
};

/** 미리보기에서 요청한 안내를 이미 띄웠는지 (역할을 바꿔 화면이 다시 그려져도 또 띄우지 않게) */
let tourHandled = 0;

// ── 앱: 로그인 → (사이트 관리 | 등록 신청 | 주유소 대시보드) ─────────────
type View = 'station' | 'admin' | 'apply' | 'preview';

const legalOf = (): LegalKind | null => (location.hash === '#privacy' ? 'privacy' : location.hash === '#terms' ? 'terms' : null);

export default function App() {
  const [legal, setLegal] = useState<LegalKind | null>(legalOf);
  useEffect(() => {
    const on = () => {
      setLegal(legalOf());
      if (legalOf()) window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  if (legal)
    return (
      <LegalPage
        kind={legal}
        onBack={() => {
          if (history.length > 1) history.back();
          else location.hash = '';
        }}
      />
    );
  return <Main />;
}

function Main() {
  const [session, setSession] = useState<Session | null | undefined>();
  const [me, setMe] = useState<Profile | null | undefined>();
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [applications, setApplications] = useState<Station[]>([]);
  const [stationId, setStationId] = useState<string | null>(() => store.get('station'));
  const [view, setView] = useState<View>('station');
  /** 미리보기에서 "데모 주유소에서 안내 시작" 을 누를 때마다 올라감 */
  const [tourReq, setTourReq] = useState(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setMe(session === null ? null : undefined);
      return;
    }
    supabase
      .from('profiles')
      .select('id,email,name,is_site_admin')
      .eq('id', session.user.id)
      .maybeSingle()
      .then(({ data }) =>
        setMe((data as Profile) ?? { id: session.user.id, email: session.user.email ?? '', name: '', is_site_admin: false }),
      );
  }, [session]);

  const loadStations = useCallback(async () => {
    if (!me) return;
    const [m, a] = await Promise.all([
      supabase.from('station_members').select('role,is_manager,stations(*)').eq('user_id', me.id),
      supabase.from('stations').select('*').eq('applied_by', me.id).neq('status', 'approved').order('created_at'),
    ]);
    const byStation = new Map<string, Membership>();
    for (const row of (m.data ?? []) as unknown as Array<{ role: Role; is_manager: boolean; stations: Station }>) {
      if (!row.stations || row.stations.status !== 'approved') continue;
      const cur = byStation.get(row.stations.id) ?? { station: row.stations, roles: [], managerRoles: [] };
      cur.roles.push(row.role);
      if (row.is_manager) cur.managerRoles.push(row.role);
      byStation.set(row.stations.id, cur);
    }
    const list = [...byStation.values()].sort((x, y) => Number(x.station.is_demo) - Number(y.station.is_demo) || x.station.name.localeCompare(y.station.name));
    setMemberships(list);
    setApplications((a.data as Station[]) ?? []);
    // 로그인 화면에서 "새 주유소 등록"으로 들어왔으면 바로 신청 화면으로
    try {
      if (localStorage.getItem('intent:apply')) {
        localStorage.removeItem('intent:apply');
        if (list.length) setView('apply');
      }
    } catch {
      /* 저장소 못 쓰는 브라우저 */
    }
  }, [me]);

  useEffect(() => {
    loadStations();
  }, [loadStations]);

  // 마지막 요청 기록: 서버 요청마다 최대 1분에 한 번 (supabase.ts). 여기서는 누구·어느 주유소인지만 알려 줌
  const activeSid = memberships?.length ? (memberships.find((x) => x.station.id === stationId) ?? memberships[0]).station.id : null;
  useEffect(() => {
    activity.signedIn = !!me && memberships !== null && !isDemo();
    activity.sid = view === 'station' ? activeSid : null;
    if (activity.signedIn) markActivity();
  }, [me, memberships, activeSid, view]);

  if (session === undefined || (session && (me === undefined || (me && memberships === null)))) {
    return <Loading size="page" />;
  }
  if (!session || !me) return <Landing />;

  const current = memberships!.find((x) => x.station.id === stationId) ?? memberships![0];
  const pick = (id: string) => {
    setStationId(id);
    store.set('station', id);
    setView('station');
  };

  const bar: BarRender = (ctx) => (
    <TopBar me={me} memberships={memberships!} current={view === 'station' ? current : undefined} view={view} onPick={pick} onView={setView} ctx={ctx} />
  );

  if (view === 'preview' && me.is_site_admin) {
    const demo = memberships!.find((x) => x.station.is_demo);
    return (
      <Preview
        me={me}
        frame={(children) => <Frame bar={() => null}>{children}</Frame>}
        onClose={() => setView('admin')}
        onTour={
          demo
            ? () => {
                pick(demo.station.id);
                setTourReq((n) => n + 1);
              }
            : undefined
        }
      />
    );
  }
  if (view === 'admin' && me.is_site_admin) {
    return (
      <Frame bar={bar}>
        <AdminConsole me={me} onChanged={loadStations} />
      </Frame>
    );
  }
  if (view === 'apply' || !current) {
    return (
      <Frame bar={bar}>
        <Onboarding
          me={me}
          applications={applications}
          hasStations={!!current}
          onChanged={loadStations}
          onDone={() => setView('station')}
        />
      </Frame>
    );
  }
  return <StationApp key={`${current.station.id}:${current.station.operation}`} me={me} membership={current} bar={bar} onChanged={loadStations} tourReq={tourReq} />;
}

/** 주유소 밖 화면 (사이트 관리, 등록 신청): 꺼진 간판 + 책상 */
function Frame({ bar, children }: { bar: BarRender; children: ReactNode }) {
  const [market, setMarket] = useState<MarketLatest | null>(null);
  useEffect(() => {
    getJSON<MarketLatest>('market/latest.json').then(setMarket);
  }, []);
  return (
    <>
    {bar()}
    <div className="lot frame">
      <aside className="pylon" aria-hidden>
        <div className="pylon-face">
          <div className="pylon-brand">
            <span className="brand">만땅</span>
            <span className="addr">주유소 운영 장부</span>
          </div>
          <div className="board">
            <div className="board-row">
              <span className="board-label">휘발유</span>
              <Led value={null} digits={4} label="휘발유" />
            </div>
            <div className="board-row">
              <span className="board-label">경유</span>
              <Led value={null} digits={4} label="경유" />
            </div>
          </div>
        </div>
        {market ? <PoleBoard market={market} /> : <div className="pole" />}
      </aside>
      <main className="desk">{children}</main>
    </div>
    </>
  );
}

/** 주유소 화면에서 상단 바에 더 들어가는 것 (역할 전환, 설정·의견 탭) */
interface StationCtx {
  roles: Role[];
  role: Role;
  onRole: (r: Role) => void;
  isManager: boolean;
  tab: TabId;
  onTab: (t: TabId) => void;
  onTour: () => void;
  selfOperated: boolean;
}
type BarRender = (ctx?: StationCtx) => ReactNode;

/** 상단 바: 왼쪽 주유소·역할, 오른쪽 설정·계정 메뉴 */
/** 데모일 때 맨 위 띠: 예시 데이터라는 것, 처음부터, 로그인하러 가기 */
function DemoBar() {
  return (
    <div className="demo-bar" role="note">
      <p>
        <b>데모</b>
        <span>예시 주유소의 예시 데이터입니다. 눌러서 바꾼 내용은 이 탭에만 남습니다.</span>
      </p>
      <span className="demo-bar-actions">
        <button
          type="button"
          onClick={() => {
            resetDemoData();
            location.reload();
          }}
        >
          처음부터
        </button>
        <button type="button" className="on" onClick={exitDemo}>
          로그인·등록하기
        </button>
      </span>
    </div>
  );
}

function TopBar({
  me,
  memberships,
  current,
  view,
  onPick,
  onView,
  ctx,
}: {
  me: Profile;
  memberships: Membership[];
  current?: Membership;
  view: View;
  onPick: (id: string) => void;
  onView: (v: View) => void;
  ctx?: StationCtx;
}) {
  const canSwitch = memberships.length > 1 || (memberships.length > 0 && view !== 'station');
  const pw = useHasPassword();
  const [pwOpen, setPwOpen] = useState(false);
  const title = view === 'admin' ? '사이트 관리' : view === 'apply' ? '주유소 등록' : current?.station.name ?? '만땅';
  return (
    <header className="topbar">
      {isDemo() && <DemoBar />}
      <div className="topbar-inner">
        <div className="tb-left">
          {canSwitch ? (
            <label className="tb-station">
              <span className="sr-only">주유소 고르기</span>
              <select value={view === 'station' ? current?.station.id ?? '' : ''} onChange={(e) => e.target.value && onPick(e.target.value)}>
                {view !== 'station' && <option value="">{title}</option>}
                {memberships.map((m) => (
                  <option key={m.station.id} value={m.station.id}>
                    {m.station.name}
                    {m.station.is_demo ? ' (데모)' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="tb-title">{title}</span>
          )}
          {ctx &&
            (ctx.roles.length > 1 ? (
              <span className="seg seg-sm tb-role" role="group" aria-label="어느 역할로 볼지" data-tour="role">
                {ctx.roles.map((r) => (
                  <button key={r} type="button" aria-pressed={r === ctx.role} onClick={() => ctx.onRole(r)}>
                    {ROLE_KO[r]}
                  </button>
                ))}
              </span>
            ) : (
              <span className="chip tb-role" data-tour="role">
                {ctx.selfOperated && ctx.role === 'owner' ? '직접 운영' : ROLE_KO[ctx.role]}
                {ctx.isManager && <span className="tb-long"> · 관리자</span>}
              </span>
            ))}
        </div>
        <nav className="tb-right" aria-label="계정">
          <ChatButton />
          {ctx?.isManager && (
            <button type="button" className="tb-btn" aria-label="주유소 설정" aria-pressed={ctx.tab === 'settings'} onClick={() => ctx.onTab('settings')} data-tour="settings">
              <svg viewBox="0 0 20 20" aria-hidden width="18" height="18">
                <path
                  fill="currentColor"
                  d="M11.6 1.5l.5 2.3c.5.2 1 .5 1.4.8l2.2-.8 1.6 2.8-1.7 1.6c.1.5.1 1.1 0 1.6l1.7 1.6-1.6 2.8-2.2-.8c-.4.3-.9.6-1.4.8l-.5 2.3H8.4l-.5-2.3c-.5-.2-1-.5-1.4-.8l-2.2.8-1.6-2.8 1.7-1.6a5 5 0 010-1.6L2.7 7.4l1.6-2.8 2.2.8c.4-.3.9-.6 1.4-.8l.5-2.3h3.2zM10 7a3 3 0 100 6 3 3 0 000-6z"
                />
              </svg>
              <span className="tb-btn-label">
                <span className="tb-long">주유소 </span>설정
              </span>
            </button>
          )}
          <AccountMenu
            me={me}
            items={[
              ...(ctx ? [{ label: '의견·버그 보내기', on: () => ctx.onTab('feedback') }, { label: '사용 안내', on: ctx.onTour }] : []),
              ...(memberships.length > 0 ? [{ label: view === 'apply' ? '대시보드로 돌아가기' : '주유소 등록 신청', on: () => onView(view === 'apply' ? 'station' : 'apply') }] : []),
              ...(me.is_site_admin ? [{ label: view === 'admin' ? '대시보드로 돌아가기' : '사이트 관리', on: () => onView(view === 'admin' ? 'station' : 'admin') }] : []),
              ...(me.is_site_admin ? [{ label: '새 사용자 화면 보기', on: () => onView('preview') }] : []),
              ...(isDemo() ? [] : [{ label: pw?.has ? '비밀번호 바꾸기' : '비밀번호 만들기', on: () => setPwOpen(true) }]),
              { label: '로그아웃', on: () => supabase.auth.signOut(), danger: true },
            ]}
          />
        </nav>
      </div>
      <PasswordSheet open={pwOpen} onClose={() => setPwOpen(false)} />
      <ChatPanel me={me} />
    </header>
  );
}

function AccountMenu({ me, items }: { me: Profile; items: Array<{ label: string; on: () => void; danger?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const site = useSiteConfig();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | globalThis.KeyboardEvent) => {
      if (e instanceof globalThis.KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref} data-tour="account">
      <button type="button" className="avatar" aria-haspopup="menu" aria-expanded={open} aria-label="계정 메뉴" onClick={() => setOpen(!open)}>
        {(me.name || me.email).slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div className="menu-panel" role="menu">
          <p className="menu-who">
            {me.name && <b>{me.name}</b>}
            <span>{me.email}</span>
          </p>
          {[...items.filter((it) => !it.danger), ...(site?.donate_url ? [{ label: '☕ 개발자에게 커피 후원', on: () => window.open(site.donate_url, '_blank', 'noopener,noreferrer') }] : []), ...items.filter((it) => it.danger)].map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={it.danger ? 'danger' : undefined}
              onClick={() => {
                setOpen(false);
                it.on();
              }}
            >
              {it.label}
            </button>
          ))}
          <p className="menu-legal">
            <a href="#privacy">개인정보처리방침</a>
            <a href="#terms">이용약관</a>
          </p>
        </div>
      )}
    </div>
  );
}

// ── 주유소 대시보드 ─────────────────────────────────────────────────
interface PermRow {
  role: Role;
  is_manager: boolean;
  area: Area;
  can_read: boolean;
  can_write: boolean;
}

function StationApp({
  me,
  membership,
  bar,
  onChanged,
  tourReq,
}: {
  me: Profile;
  membership: Membership;
  bar: BarRender;
  onChanged: () => void;
  tourReq: number;
}) {
  const { station, roles } = membership;
  const [rows, setRows] = useState<PermRow[] | null>(null);
  const [role, setRole] = useState<Role>(() => {
    const saved = store.get(`role:${station.id}`) as Role | null;
    return saved && roles.includes(saved) ? saved : roles[0];
  });

  useEffect(() => {
    supabase.rpc('my_permissions', { sid: station.id }).then(({ data }) => setRows((data as PermRow[]) ?? []));
  }, [station.id]);

  if (!rows) return <Loading size="page" />;
  const mine = rows.filter((r) => r.role === role);
  const perms = Object.fromEntries(
    (['prices', 'land', 'policy', 'contracts', 'inspections', 'payments', 'supplies', 'fuel'] as Area[]).map((a) => {
      const r = mine.find((x) => x.area === a);
      return [a, { read: !!r?.can_read, write: !!r?.can_write }];
    }),
  ) as Perms;
  const isManager = mine.some((r) => r.is_manager);

  const onRole = (r: Role) => {
    setRole(r);
    store.set(`role:${station.id}`, r);
  };

  return (
    <Dashboard
      key={role}
      me={me}
      station={station}
      perms={perms}
      isManager={isManager}
      bar={bar}
      roles={roles}
      role={role}
      onRole={onRole}
      onChanged={onChanged}
      tourReq={tourReq}
    />
  );
}

function Dashboard({
  me,
  station,
  perms,
  isManager,
  bar,
  roles,
  role,
  onRole,
  onChanged,
  tourReq,
}: {
  me: Profile;
  station: Station;
  perms: Perms;
  isManager: boolean;
  bar: BarRender;
  roles: Role[];
  role: Role;
  onRole: (r: Role) => void;
  onChanged: () => void;
  tourReq: number;
}) {
  const sid = station.id;
  const allowed: readonly TabId[] = [
    ...TABS.map((t) => t.id).filter((id) => perms[TAB_AREA[id]!].read && (station.operation !== 'self' || !LEASE_TABS.includes(id))),
    ...(isManager ? (['settings'] as const) : []),
    'feedback',
    ...(perms.supplies.write ? (['counter'] as const) : []),
  ];
  const visibleTabs = TABS.filter((t) => allowed.includes(t.id));
  const [prices, setPrices] = useState<{ latest: PriceLatest; history: PriceHistoryEntry[] } | null | undefined>();
  const [land, setLand] = useState<LandLatest | null>(null);
  const [market, setMarket] = useState<MarketLatest | null>(null);
  const [index, setIndex] = useState<PolicyIndexEntry[] | null>(null);
  const [week, setWeek] = useState('');
  const [report, setReport] = useState<PolicyReport | null>(null);
  const [tab, setTab] = useState<TabId>(() => tabFromHash(allowed));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // 기능 안내: 처음 들어온 사람에게 한 번, 그 뒤로는 계정 메뉴 "사용 안내" 에서
  const tourKey = `tour:v1:${me.id}`;
  const [touring, setTouring] = useState(false);
  const tourFrom = useRef<TabId>(tab);
  const startTour = useCallback(() => {
    tourFrom.current = tab;
    setTouring(true);
  }, [tab]);
  useEffect(() => {
    if (tab === 'counter') return; // 카운터 화면으로 바로 연 기기에서는 안내를 띄우지 않음
    if (tourReq > tourHandled || !store.get(tourKey)) {
      tourHandled = tourReq;
      const t = window.setTimeout(startTour, 500);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourReq]);
  const endTour = () => {
    setTouring(false);
    store.set(tourKey, new Date().toISOString());
    select(tourFrom.current);
    window.scrollTo({ top: 0 });
  };
  const tourSteps: TourStep[] = useMemo(
    () =>
      stationSteps({
        stationName: station.name,
        tabs: visibleTabs.map((t) => t.id),
        canPrices: perms.prices.read,
        multiRole: roles.length > 1,
        isManager,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [station.name, perms.prices.read, roles.length, isManager],
  );

  useEffect(() => {
    const onHash = () => setTab(tabFromHash(allowed));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManager]);

  const select = (id: TabId) => {
    setTab(id);
    history.replaceState(null, '', `#${id}`);
  };

  // 탭 목록 키보드 이동 (←→↑↓, Home, End)
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = visibleTabs.length - 1;
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i === last ? 0 : i + 1)
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i === 0 ? last : i - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (next == null) return;
    e.preventDefault();
    select(visibleTabs[next].id);
    tabRefs.current[next]?.focus();
  };

  useEffect(() => {
    if (!perms.prices.read) return;
    Promise.all([getJSON<PriceLatest>(`st/${sid}/prices/latest.json`), getJSON<PriceHistoryEntry[]>(`st/${sid}/prices/history.json`)]).then(
      ([latest, history]) => setPrices(latest ? { latest, history: history ?? [] } : null),
    );
  }, [perms.prices.read, sid]);
  useEffect(() => {
    if (perms.prices.read) getJSON<MarketLatest>('market/latest.json').then(setMarket);
  }, [perms.prices.read]);
  useEffect(() => {
    if (perms.land.read) getJSON<LandLatest>(`st/${sid}/land/latest.json`).then(setLand);
  }, [perms.land.read, sid]);
  useEffect(() => {
    if (!perms.policy.read) return;
    getJSON<PolicyIndexEntry[]>('policy/index.json').then((list) => {
      setIndex(list ?? []);
      if (list?.length) setWeek(list[0].week);
    });
  }, [perms.policy.read]);

  useEffect(() => {
    const entry = index?.find((e) => e.week === week);
    if (entry) getJSON<PolicyReport>(`policy/${entry.file}`).then(setReport);
  }, [index, week]);

  const stats = prices?.latest.stats;
  const { head, tail } = splitName(station.name);
  /** 설정·의견 화면에는 가격판·국제 시세를 띄우지 않음 */
  const plain = tab === 'settings' || tab === 'feedback';

  if (tab === 'counter') return <Counter station={station} onExit={() => select('supplies')} />;

  return (
    <>
    {bar({ roles, role, onRole, isManager, tab, onTab: select, onTour: startTour, selfOperated: station.operation === 'self' })}
    {touring && <Tour steps={tourSteps} onStep={(st) => st.tab && select(st.tab as TabId)} onClose={endTour} />}
    <div className="lot">
      <aside className="pylon" aria-label={`${station.name} 간판`}>
        <div className="pylon-face">
          <div className="pylon-brand">
            <h1 className="brand">{head}</h1>
            <span className="addr">
              {tail && <>{tail}, </>}
              {station.is_demo ? '버그 재현·기능 개발용' : prices?.latest.station.address || station.address}
            </span>
          </div>

          {perms.prices.read && !plain && (
            <div className="board">
              <div className="board-row">
                <span className="board-label">휘발유</span>
                <Led value={stats?.gasoline.ours ?? null} digits={4} label="휘발유" />
              </div>
              <div className="board-row">
                <span className="board-label">경유</span>
                <Led value={stats?.diesel.ours ?? null} digits={4} label="경유" />
              </div>
              {stats && (
                <p className="board-foot">
                  반경 {prices!.latest.radiusKm}km에서 휘발유는 {stats.gasoline.n + 1}곳 중 {stats.gasoline.rank ?? '-'}위, 경유는{' '}
                  {stats.diesel.n + 1}곳 중 {stats.diesel.rank ?? '-'}위로 쌉니다
                </p>
              )}
            </div>
          )}

          <div className="subsigns" role="tablist" aria-label="메뉴" aria-orientation="horizontal">
            {visibleTabs.map((t, i) => (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="panel"
                tabIndex={tab === t.id ? 0 : -1}
                className="live"
                onClick={() => select(t.id)}
                onKeyDown={(e) => onTabKey(e, i)}
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>
        {market && !plain ? <PoleBoard market={market} /> : <div className="pole" aria-hidden />}
      </aside>

      <main className="desk">
        <div id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={-1} className="panel">
          {tab === 'prices' && (
            <>
              {prices === undefined && <Loading />}
              {prices === null && (
                <section className="block">
                  <header className="block-head">
                    <h2>반경 5km 가격</h2>
                  </header>
                  <p className="note">
                    {station.opinet_id
                      ? '아직 가격 데이터가 없습니다. 4시간마다 자동으로 모입니다.'
                      : '오피넷 주유소가 연결되지 않아 가격을 모으지 못합니다. 사이트 관리자에게 의견 보내기로 알려 주세요.'}
                  </p>
                </section>
              )}
              {prices && <PriceSection latest={prices.latest} history={prices.history} />}
              {market && <MarketSection market={market} prices={prices?.latest ?? null} />}
            </>
          )}

          {tab === 'land' &&
            (land ? (
              <LandSection land={land} />
            ) : (
              <p className="note">
                {station.lawd_cd
                  ? '부지 가치 데이터가 아직 없습니다. 매주 월요일 아침에 자동으로 모입니다.'
                  : '실거래가 지역코드가 아직 없어 부지 가치를 모으지 못합니다. 사이트 관리자가 확인 중입니다.'}
              </p>
            ))}

          {tab === 'policy' && (
            <section className="block" aria-labelledby="policy-title">
              <header className="block-head">
                <h2 id="policy-title">업계·정책 주간 요약</h2>
                {index && index.length > 1 && (
                  <div className="seg" role="group" aria-label="지난 리포트">
                    {index.slice(0, 8).map((e) => (
                      <button key={e.week} type="button" aria-pressed={e.week === week} onClick={() => setWeek(e.week)}>
                        {Number(e.week.split('-W')[1])}주차
                      </button>
                    ))}
                  </div>
                )}
              </header>

              {index?.length === 0 && <p className="note">아직 리포트가 없습니다. 매주 월요일 아침에 자동으로 만들어집니다.</p>}
              {report && <Report report={report} />}
            </section>
          )}

          {visibleTabs.length === 0 && tab !== 'settings' && tab !== 'feedback' && (
            <p className="readout">이 계정에 열려 있는 메뉴가 없습니다. 주유소 관리자에게 권한을 요청해 주세요.</p>
          )}
          {tab === 'inspection' && <InspectionSection me={me} stationId={sid} canWrite={perms.inspections.write} />}
          {tab === 'contract' && <ContractSection me={me} stationId={sid} canWrite={perms.contracts.write} selfOperated={station.operation === 'self'} />}
          {tab === 'payment' && (
            <PaymentSection me={me} stationId={sid} canWrite={perms.payments.write} canEditContracts={perms.contracts.write} />
          )}
          {tab === 'supplies' && <SupplySection station={station} canWrite={perms.supplies.write} />}
          {tab === 'fuel' && <FuelSection station={station} role={role} canWrite={perms.fuel.write} latest={prices?.latest ?? null} history={prices?.history ?? []} market={market} />}
          {tab === 'settings' && isManager && <StationSettings me={me} station={station} onChanged={onChanged} />}
          {tab === 'feedback' && <FeedbackSection me={me} stationId={sid} page={station.name} />}
        </div>

        <footer className="foot">
          이 주유소의 회원만 볼 수 있습니다. 회원과 메뉴별 권한은 주유소 관리자가 주유소 설정에서 정합니다.
        </footer>
      </main>
    </div>
    </>
  );
}

/** 기둥 중간에 국제 시세판을 단다 */
function PoleBoard({ market }: { market: MarketLatest }) {
  return (
    <>
      <div className="pole pole-top" aria-hidden />
      <MarketBoard market={market} />
      <div className="pole pole-bottom" aria-hidden />
    </>
  );
}

function Report({ report }: { report: PolicyReport }) {
  const groups = useMemo(() => {
    const map = new Map<string, PolicyItem[]>();
    for (const it of report.items) map.set(it.category, [...(map.get(it.category) ?? []), it]);
    return [...map.entries()];
  }, [report]);
  const hot = report.items.filter((i) => i.importance === 3).length;

  return (
    <article className="report">
      <p className="block-meta">
        {md(report.period.from)} – {md(report.period.to)}, 기사 {report.stats.collected}건에서 {report.stats.selected}건을 골랐습니다
        {hot > 0 && <>. 중요 {hot}건</>}
        {report.mode === 'raw' && <em className="raw"> (AI 요약 없이 최신순)</em>}
      </p>
      {report.headline && <p className="headline">{report.headline}</p>}

      {report.watch.length > 0 && (
        <aside className="watch">
          <h3>다음 주에 볼 것</h3>
          <ul>
            {report.watch.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </aside>
      )}

      {report.items.length === 0 && <p className="note">이번 주에는 부지 판단에 영향을 줄 기사가 없었습니다.</p>}

      {groups.map(([cat, items]) => (
        <section key={cat} className="lane">
          <h3 className="lane-name">{cat}</h3>
          <ol className="items">
            {items.map((it) => (
              <li key={it.url} className={`item imp-${it.importance}`}>
                <span className="lamp" title={['', '참고', '추세', '중요'][it.importance]} />
                <div className="item-body">
                  <a href={it.url} target="_blank" rel="noreferrer noopener" className="item-title">
                    {it.title}
                  </a>
                  {it.summary && <p className="item-summary">{it.summary}</p>}
                  {it.impact && (
                    <p className="item-impact">
                      <b>우리 부지</b>
                      {it.impact}
                    </p>
                  )}
                  <p className="item-src">
                    <span>{it.source}</span>
                    <time dateTime={it.publishedAt}>{md(it.publishedAt)}</time>
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </article>
  );
}
