import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import pdf from "pdf-parse";

const FOLDER_ID = "1P2oKySmyy0jnahIqw1-RHRHRz8A_nJ29";
const MAX_CHARS_PER_PDF = 25000;
const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function getDriveClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version: "v3", auth });
}

// フォルダ内の全PDFを再帰的に取得
async function getAllPDFs(drive, folderId) {
  const files = [];

  // サブフォルダ一覧（最新順）
  const foldersRes = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    orderBy: "name desc",
    pageSize: 20,
  });

  // 各サブフォルダのPDFを取得
  for (const folder of foldersRes.data.files || []) {
    const res = await drive.files.list({
      q: `'${folder.id}' in parents and mimeType = 'application/pdf' and trashed = false`,
      fields: "files(id, name, modifiedTime)",
      orderBy: "modifiedTime desc",
      pageSize: 20,
    });
    for (const f of res.data.files || []) {
      files.push({ ...f, folderName: folder.name });
    }
  }

  // ルート直下のPDFも取得
  const rootRes = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`,
    fields: "files(id, name, modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 20,
  });
  for (const f of rootRes.data.files || []) {
    files.push({ ...f, folderName: "" });
  }

  return files;
}

async function extractPDFText(drive, fileId) {
  const response = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  const buffer = Buffer.from(response.data);
  const parsed = await pdf(buffer);
  return parsed.text.slice(0, MAX_CHARS_PER_PDF);
}

// テキストから期限日付を抽出して、期限切れかどうか判定
function isExpired(text) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 日付パターンを抽出（令和・西暦両対応）
  const patterns = [
    // 西暦: 2025年5月14日、2025/05/14、2025-05-14
    /20(\d{2})[年\/\-](\d{1,2})[月\/\-](\d{1,2})日?/g,
    // 令和: 令和7年5月14日
    /令和(\d{1,2})年(\d{1,2})月(\d{1,2})日/g,
  ];

  const dates = [];

  // 西暦パターン
  const p1 = /20(\d{2})[年\/\-](\d{1,2})[月\/\-](\d{1,2})日?/g;
  let m;
  while ((m = p1.exec(text)) !== null) {
    const d = new Date(2000 + parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    dates.push(d);
  }

  // 令和パターン（令和1年=2019年）
  const p2 = /令和(\d{1,2})年(\d{1,2})月(\d{1,2})日/g;
  while ((m = p2.exec(text)) !== null) {
    const year = 2018 + parseInt(m[1]);
    const d = new Date(year, parseInt(m[2]) - 1, parseInt(m[3]));
    dates.push(d);
  }

  if (dates.length === 0) {
    // 日付が見つからない場合は有効として扱う
    return false;
  }

  // 最も新しい日付を締め切りと見なす
  const latestDate = new Date(Math.max(...dates.map((d) => d.getTime())));

  // 最新日付が今日より前なら期限切れ
  return latestDate < today;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { messages } = req.body;
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  try {
    const drive = getDriveClient();
    const pdfFiles = await getAllPDFs(drive, FOLDER_ID);

    // 全PDFを並列でテキスト抽出
    const allContents = (
      await Promise.allSettled(
        pdfFiles.map(async (file) => {
          const text = await extractPDFText(drive, file.id);
          return { name: file.name, folder: file.folderName, text };
        })
      )
    )
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);

    // 期限切れでないPDFだけ残す
    const validContents = allContents.filter((p) => !isExpired(p.text));

    // 有効なPDFがなければ全部使う（フォールバック）
    const pdfContents = validContents.length > 0 ? validContents : allContents;

    const systemPrompt = `あなたは助成金・補助金の専門アドバイザーAIです。以下は現在申請可能な（期限切れでない）補助金・助成金の情報です。この情報をもとに、ユーザーに最適なものを会話形式で案内してください。

【現在有効な補助金・助成金情報】（本日: ${TODAY}）
${pdfContents.map((p) => `---\n${p.text}`).join("\n")}

【回答スタイル】
- 友達に話しかけるような、やさしい話し言葉で答える
- 「〜ですよ」「〜できますよ」「〜がおすすめです！」のような自然なトーンで
- 難しい専門用語はなるべく使わず、かんたんな言葉で説明する
- ユーザーの状況に合わせて、一番おすすめの補助金を先に教える
- 補助金名、もらえる金額、締め切り日、対象かどうかのポイントだけ簡潔に伝える
- 表やリストは使わず、自然な文章で話す
- ファイル名や参照元は書かない
- 期限切れの補助金は絶対に紹介しない
- 情報がない場合は「今のデータにはないけど、商工会議所に問い合わせてみると良いですよ」と提案する
- 最後に「他に気になることはありますか？」など次の会話につながる一言を添える
- 回答は長くなりすぎず、読みやすい長さにまとめる`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    res.status(200).json({ answer: response.content[0].text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
