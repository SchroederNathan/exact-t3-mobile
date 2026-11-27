import { object, string } from "./connection";

export function pullCounts(raw: Record<string, unknown>) {
  const label = (value:unknown, prefix:string) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? `${prefix}${value.toLocaleString()}` : "";
  const count = raw.changedFiles ?? raw.changedFileCount;
  return {added:label(raw.additions ?? raw.addedLines,"+"), deleted:label(raw.deletions ?? raw.deletedLines,"−"), files: typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? `${count.toLocaleString()} ${count === 1 ? "file" : "files"}` : ""};
}

export function pullRow(value: unknown) {
  const raw = object(value);
  const author = string(object(raw.author).login) || string(raw.author);
  const status = raw.state === "merged" ? "Merged" : raw.state === "closed" ? "Closed" : raw.isDraft === true ? "Draft" : "Open";
  const labels = (Array.isArray(raw.labels) ? raw.labels : []).flatMap((entry: unknown) => {
    const label = object(entry);
    const name = string(label.name);
    const hex = string(label.color).replace(/^#/, "");
    return name ? [{ name, color: /^[a-f\d]{6}$/i.test(hex) ? `#${hex}` : "" }] : [];
  });
  const stack = object(raw.stack);
  const stackText = Number.isSafeInteger(stack.position) && Number.isSafeInteger(stack.size) && Number(stack.position) > 0 && Number(stack.position) <= Number(stack.size) ? `${stack.position}/${stack.size}` : "";
  const checks = string(raw.checksState);
  const review = raw.reviewDecision === "changes-requested" ? "Changes requested" : raw.reviewDecision === "approved" ? "Reviews approved" : raw.viewerReviewRequested === true ? "Your review requested" : raw.reviewDecision === "review-required" ? "Review required" : "";
  const conflict = status === "Open" && raw.mergeability === "conflicting";
  const additions = Number(raw.additions ?? 0);
  const deletions = Number(raw.deletions ?? 0);
  return {
    status, conflict, checks, review, stackText, labels: labels.slice(0, 2), allLabels:labels, extraLabels: Math.max(0, labels.length - 2),
    initial: Array.from(author)[0]?.toUpperCase() || "?", updatedMs: Date.parse(string(raw.updatedAt)) || 0,
    addedText: additions > 0 ? `+${additions.toLocaleString()}` : "", deletedText: deletions > 0 ? `−${deletions.toLocaleString()}` : "",
    accessible: [ `${raw.provider === "gitlab" ? "Merge request" : "Pull request"} ${raw.number}`, string(raw.title), status,
      conflict ? (raw.baseBranch ? `conflicts with ${raw.baseBranch}` : "has conflicts") : "", `by ${author || "unknown author"}`, review,
      checks ? `checks ${checks}` : "", stackText ? `stack ${stack.position} of ${stack.size}` : "", ...labels.map(label => label.name),
      `${additions} additions`, `${deletions} deletions` ].filter(Boolean).join(", "),
  };
}
