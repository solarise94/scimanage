import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export const proxy = withAuth(
  function () {
    return NextResponse.next();
  },
  {
    callbacks: {
      authorized({ req, token }) {
        if (req.nextUrl.pathname.startsWith("/api/auth")) return true;
        return !!token;
      },
    },
    pages: {
      signIn: "/login",
    },
  }
);

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/projects/:path*",
    "/tickets/:path*",
    "/customers/:path*",
    "/profile/:path*",
    "/admin/:path*",
    "/api/projects/:path*",
    "/api/tickets/:path*",
    "/api/customers/:path*",
    "/api/dashboard/:path*",
    "/api/upload/:path*",
    "/api/reminders/:path*",
    "/api/notifications/:path*",
    "/api/draft-media/:path*",
    "/api/project-invoices/:path*",
    "/api/billing-profiles/:path*",
    "/api/tax-id-lookup/:path*",
    "/external-orders/:path*",
    "/api/external-orders/:path*",
    "/api/external-order-invoices/:path*",
    "/crm/:path*",
    "/api/crm/:path*",
  ],
};
