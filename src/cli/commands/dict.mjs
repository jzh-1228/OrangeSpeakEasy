import { LocalizedError, msg } from "../../i18n/index.mjs";
import { openVocabulary, readImportFile } from "../../storage/vocabulary.mjs";
import { parse, say, UsageError } from "../common.mjs";

// orangespeakeasy dict：看、加、删、导入词典。词典只是本机的一个文件（storage/vocabulary.mjs），这里直接读写，
// 不经过后台应用：后台每次听写时重读一次，改完下一句话就用上。

const usage = () => new UsageError(msg("cli.dict.usage"));

export async function dict(args, io) {
  const { values, positionals } = parse(args, { json: { type: "boolean", default: false } });
  const [action, ...rest] = positionals;
  // --json 只给"看"用：加、删、导入的结果是给人看的话
  if (values.json && action !== undefined) throw usage();
  const vocabulary = openVocabulary(io.paths.vocabularyFile);

  if (action === undefined) {
    const terms = vocabulary.terms();
    if (values.json) io.out(JSON.stringify(terms));
    else if (terms.length === 0) say(io, msg("cli.dict.empty"));
    else {
      say(io, msg("cli.dict.header", { count: terms.length, file: io.paths.vocabularyFile }));
      for (const term of terms) io.out(`  ${term}`);
    }
    return 0;
  }

  if (action === "add") {
    if (rest.length === 0) throw usage();
    // 一个一个加：重复、太长的说清楚，其余照加
    let failed = 0;
    for (const raw of rest) {
      try {
        say(io, msg("cli.dict.added", { term: vocabulary.add(raw) }));
      } catch (error) {
        if (!(error instanceof LocalizedError)) throw error;
        failed += 1;
        io.err(io.t("cli.dict.notAdded", { term: raw.trim(), reason: io.t.text(error.problem) }));
      }
    }
    return failed > 0 ? 1 : 0;
  }

  if (action === "remove") {
    if (rest.length === 0) throw usage();
    // 同 add：有一个不在词典里就照实说、以 1 退出，在的照删
    const { removed, missing } = vocabulary.remove(rest);
    if (removed > 0) say(io, msg("cli.dict.removed", { count: removed }));
    if (missing.length > 0) io.err(io.t("vocabulary.notFound", { term: io.t.list(missing) }));
    return missing.length > 0 ? 1 : 0;
  }

  if (action === "import") {
    if (rest.length !== 1) throw usage();
    const preview = vocabulary.preview(await readImportFile(rest[0]));
    const added = vocabulary.importTerms(preview.terms);
    say(
      io,
      msg("cli.dict.imported", {
        count: added,
        existing: preview.existing,
        duplicates: preview.duplicates,
        invalid: preview.invalid,
      }),
    );
    return 0;
  }

  throw usage();
}
