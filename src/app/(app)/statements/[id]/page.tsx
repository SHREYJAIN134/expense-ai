import { redirect } from "next/navigation";

/** A statement's detail view is the transaction explorer filtered to that statement. */
export default async function StatementDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/ledger?statementId=${encodeURIComponent(id)}`);
}
