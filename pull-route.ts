export function pullRouteKey(environmentId: string, projectId: string, host: string, repository: string) {
  return `pr-${Array.from(new TextEncoder().encode(JSON.stringify([environmentId, projectId, host, repository])), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function decodePullRoute(key: string, numberText: string) {
  if (key.length > 8195 || !/^pr-(?:[a-f\d]{2})+$/.test(key) || !/^[1-9]\d*$/.test(numberText)) return;
  const number = Number(numberText);
  if (!Number.isSafeInteger(number)) return;
  try {
    const bytes = Uint8Array.from(key.slice(3).match(/../g)!, pair => parseInt(pair,16));
    const parts = JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(bytes));
    if (!Array.isArray(parts) || parts.length !== 4 || !parts.every(part => typeof part === "string" && !/[\u0000-\u001f\u007f]/.test(part))) return;
    const [environmentId, projectId, host, repository] = parts as [string,string,string,string];
    if (!parts.every(value => value.trim()) || key !== pullRouteKey(environmentId,projectId,host,repository)) return;
    return {environmentId, projectId, host, repository, number, routeKey:key};
  } catch { return; }
}
