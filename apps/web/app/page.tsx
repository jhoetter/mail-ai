import { redirect } from "next/navigation";

// Root URL is a redirect, not a page. There's no useful "home" view in
// a mail product — the inbox IS the home. Sending users to a "Welcome"
// stub on every visit makes them think the app is broken / unfinished.
// First-time users with zero connected accounts still land on /inbox;
// the empty state there walks them to /settings/account.
export default function RootRedirect(): never {
  redirect("/inbox");
}
