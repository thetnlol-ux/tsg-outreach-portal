export async function handleLogout() {
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", "session=; Path=/; Max-Age=0");
  return new Response(null, { status: 302, headers });
}
