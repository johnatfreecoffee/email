import { Env, jsonResponse, errorResponse, optionsResponse, checkAuth } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

// Page rows out of Supabase REST under PostgREST's default max. We cap each
// request at MAX_ROWS to stay under per-worker subrequest + memory limits.
const MAX_ROWS = 5000;

async function fetchRows(env: Env, path: string): Promise<any[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) return [];
  try {
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

interface UnreadRow {
  domain_id: string | null;
  folder: string | null;
  is_starred: boolean | null;
  is_archived: boolean | null;
  is_catch_all: boolean | null;
  is_spam: boolean | null;
  is_trash: boolean | null;
}

// GET: Returns per-domain + per-folder unread counts.
//
// Implementation note: we used to issue ~7 count-only queries per domain in
// parallel (Promise.all). With 9 domains that's 63 subrequests, which crashes
// Cloudflare Workers (50-subrequest limit on free, slow even on paid). This
// version fetches every unread row in a single bounded query and tallies
// in memory — 1 subrequest regardless of domain count.
//
// Response shape (unchanged for the frontend):
//   {
//     domains: { [domain_id]: total_unread_excluding_trash },
//     folders: { [domain_id]: { inbox, sent, starred, archive, trash, spam, catchall } },
//     totals:  { inbox, sent, starred, archive, trash, spam, catchall }
//   }
export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;

  if (request.method === "OPTIONS") return optionsResponse(origin);
  if (request.method !== "GET") return errorResponse("Method not allowed", 405, origin);

  const authError = await checkAuth(context.request, env);
  if (authError) return authError;

  // Domain id list — used to seed empty entries so the frontend can render
  // zero-state badges for new domains.
  const domainsData = await fetchRows(env, "/email_domains?select=id");
  const domainIds: string[] = domainsData.map((d: any) => d.id).filter(Boolean);

  // Pull every unread row (excluding trash) in one shot. Trash unread is
  // handled by a separate small query because it's rare and shouldn't roll
  // into domain totals.
  const unreadRows = await fetchRows(
    env,
    `/email_messages?select=domain_id,folder,is_starred,is_archived,is_catch_all,is_spam,is_trash&is_read=eq.false&is_trash=eq.false&limit=${MAX_ROWS}`
  ) as UnreadRow[];

  const trashRows = await fetchRows(
    env,
    `/email_messages?select=domain_id&is_read=eq.false&is_trash=eq.true&limit=${MAX_ROWS}`
  ) as Array<{ domain_id: string | null }>;

  const domains: Record<string, number> = {};
  const folders: Record<string, Record<string, number>> = {};
  for (const id of domainIds) {
    domains[id] = 0;
    folders[id] = { inbox: 0, sent: 0, starred: 0, archive: 0, trash: 0, spam: 0, catchall: 0 };
  }

  for (const r of unreadRows) {
    if (!r.domain_id) continue;
    // Agent folders are silent — never contribute to inbox/domain badges.
    if (r.folder === "agent") continue;
    if (!folders[r.domain_id]) {
      folders[r.domain_id] = { inbox: 0, sent: 0, starred: 0, archive: 0, trash: 0, spam: 0, catchall: 0 };
      domains[r.domain_id] = 0;
    }
    const f = folders[r.domain_id];
    domains[r.domain_id] += 1;

    if (r.is_archived) {
      f.archive += 1;
    } else if (r.folder === "spam" || r.is_spam) {
      f.spam += 1;
    } else if (r.folder === "sent") {
      f.sent += 1;
    } else if (r.folder === "inbox") {
      // Inbox count = addressed mail only (matches the default inbox view).
      // Catch-alls live in their own bucket so they don't double-count.
      if (r.is_catch_all) f.catchall += 1;
      else f.inbox += 1;
    } else if (r.is_catch_all) {
      // Catch-all flagged but in some other folder — still goes to catchall
      // bucket so the sidebar count matches the catch-all view.
      f.catchall += 1;
    }
    if (r.is_starred) f.starred += 1;
  }

  for (const r of trashRows) {
    if (!r.domain_id) continue;
    if (!folders[r.domain_id]) {
      folders[r.domain_id] = { inbox: 0, sent: 0, starred: 0, archive: 0, trash: 0, spam: 0, catchall: 0 };
      domains[r.domain_id] = domains[r.domain_id] || 0;
    }
    folders[r.domain_id].trash += 1;
  }

  const totals: Record<string, number> = {
    inbox: 0, sent: 0, starred: 0, archive: 0, trash: 0, spam: 0, catchall: 0,
  };
  for (const id of Object.keys(folders)) {
    const f = folders[id];
    totals.inbox += f.inbox;
    totals.sent += f.sent;
    totals.starred += f.starred;
    totals.archive += f.archive;
    totals.trash += f.trash;
    totals.spam += f.spam;
    totals.catchall += f.catchall;
  }

  return jsonResponse({ domains, folders, totals }, 200, origin);
};
