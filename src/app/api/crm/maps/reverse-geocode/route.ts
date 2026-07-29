import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { reverseGeocode } from "@/lib/crm/geocode";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { lat, lng } = body;

  if (lat == null || lng == null) {
    return NextResponse.json({ error: "lat and lng are required" }, { status: 400 });
  }

  const res = await reverseGeocode(lat, lng);

  if (res.error) {
    if (res.status === 120) {
      return NextResponse.json({ error: "地图请求过快，请稍后重试" }, { status: 429 });
    }
    if (res.status === 110 || res.status === 111) {
      return NextResponse.json({ error: "地图 Key 未配置或无效" }, { status: 503 });
    }
    if (res.error === "地图 Key 未配置") {
      return NextResponse.json({ error: "地图 Key 未配置" }, { status: 503 });
    }
    return NextResponse.json({ error: "Geocode failed" }, { status: 502 });
  }

  return NextResponse.json({
    result: {
      address: res.result!.address,
      formattedAddress: res.result!.formattedAddress,
      province: res.result!.province,
      city: res.result!.city,
      district: res.result!.district,
      pois: res.result!.pois,
    },
  });
}
