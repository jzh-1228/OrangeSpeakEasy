import { usageReport } from "../../usage/report.mjs";
import { noPositionals, parse, renderOptions } from "../common.mjs";
import { renderUsage } from "../render/usage.mjs";

// orangespeakeasy usage：花了多少钱、多少 token、模型多久回话。历史库直接只读打开，不经过后台应用。

export async function usage(args, io) {
  const { values, positionals } = parse(args, { json: { type: "boolean", default: false } });
  noPositionals(positionals, "usage");

  let report = null;
  const db = io.openHistory(io.paths.historyDb, { readOnly: true });
  if (db !== null) {
    try {
      report = usageReport(db, { now: io.now() });
    } finally {
      db.close();
    }
  }
  io.out(values.json ? JSON.stringify(report) : renderUsage(report, renderOptions(io)));
  return 0;
}
