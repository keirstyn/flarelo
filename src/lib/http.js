export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}
