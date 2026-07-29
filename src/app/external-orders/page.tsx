"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ExternalOrdersPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/orders?source=PINGOODMICE"); }, [router]);
  return null;
}
