"use client";

import { useParams } from "next/navigation";
import { TicketDetailView } from "@/components/tickets/ticket-detail-view";

export default function TicketDetailPage() {
  const { id } = useParams();
  const ticketId = id as string;
  return <TicketDetailView ticketId={ticketId} mode="page" />;
}
