// Push-prompt policy (pure — unit tested).
//
// Old behavior: banner showed whenever there was no live PushSubscription,
// rendered before the async subscription check finished, ignored the
// browser permission, and the dismissal expired after 7 days. Result: a
// "turn on notifications" prompt on (almost) every open even though the
// permission was already granted.

export type Permission = "default" | "granted" | "denied";

export interface BannerInput {
  supported: boolean;
  /** Init (permission + subscription check) has finished. */
  ready: boolean;
  permission: Permission;
  subscribed: boolean;
  dismissed: boolean;
}

/** Only ask when the browser would actually prompt and the user hasn't said no. */
export function shouldShowPushBanner(s: BannerInput): boolean {
  return s.supported && s.ready && s.permission === "default" && !s.subscribed && !s.dismissed;
}

export type InitAction =
  | "none" //            nothing to do (unsupported / denied / never asked)
  | "sync" //            subscription exists — re-register it with the server (idempotent)
  | "resubscribe"; //    permission granted but subscription gone/stale — recreate silently

export function pushInitAction(input: {
  supported: boolean;
  permission: Permission;
  hasSubscription: boolean;
  keyMatches: boolean;
  /** User turned push off in-app — never silently resubscribe. */
  optedOut: boolean;
}): InitAction {
  if (!input.supported || input.permission !== "granted" || input.optedOut) return "none";
  if (!input.hasSubscription || !input.keyMatches) return "resubscribe";
  return "sync";
}
