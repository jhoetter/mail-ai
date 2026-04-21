import { Button, Card, PageHeader, Shell } from "@mailai/ui";
import Link from "next/link";

export default function Home() {
  return (
    <Shell
      sidebar={
        <nav className="flex flex-col gap-2 text-sm">
          <Link href="/inbox" className="hover:underline">Inbox</Link>
          <Link href="/assigned" className="hover:underline">Assigned to me</Link>
          <Link href="/pending" className="hover:underline">Pending review</Link>
        </nav>
      }
    >
      <PageHeader
        title="mail-ai"
        subtitle="AI-native email collaboration — IMAP overlay"
        actions={<Button variant="primary">Connect account</Button>}
      />
      <Card>
        <h2 className="text-base font-semibold">Welcome</h2>
        <p className="text-sm text-muted mt-2">
          This is the standalone reference shell. Backend wiring (mailbox sync, command bus,
          collaboration features) is exposed via the headless agent SDK and HTTP API; see the
          spec under <code>/spec</code>.
        </p>
      </Card>
    </Shell>
  );
}
