import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import pdf from "pdf-parse";

const FOLDER_ID = "1P2oKySmyy0jnahIqw1-RHRHRz8A_nJ29";
const MAX_CHARS_PER_PDF = 8000;  // 1ファイル8000文字に絞る
const MAX_PDF_FILES = 4;          // 最大4ファイル
const TODAY = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

function getDriveClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version: "v3", auth });
}

// 最新フォルダから最新PDFだけ取得（逐次、件数制限あり）
async function getLatestPDFs(drive, folderId) {
  const files = [];

  // サブフォルダを最新順で最大3件取得
  const foldersRes = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    orderBy: "name desc",
    pageSize: 3,
  });

  for (const folder of foldersRes.data.files || []) {
    const res = await drive.files.list({
      q: `'${folder.id}' in parents and mimeType = 'application/pdf' and trashed = false`,
      fields: "files(id, name, modifiedTime)",
      orderBy: "modifiedTime desc",
      pageSize: 2, // フォルダあたり最新2件
    });
    for (const f of res.data.files || []) {
      files.push({ ...f, folderName: folder.name });
      if (files.length >= MAX_PDF_FILES) return files;
    }
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
  // 先頭8000文字だけ使う
  return parsed.text.slice(0, MAX_CHARS_PER_PDF);
}

function isExpired(text) {
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000);
  today.setHours(0, 0, 0, 0);
  const dates = [];

  const p1 = /20(\d{2})[年\/\-](\d{1,2})[月\/\-](\d{1,2})日?/g;
  let m;
  while ((m = p1.exec(text)) !== null) {
    dates.push(new Date(2000 + parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])));
  }
  const p2 = /令和(\d{1,2})年(\d{1,2})月(\d{1,2})日/g;
  while ((m = p2.exec(text)) !== null) {
    dates.push(new Date(2018 + parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])));
  }

  if (dates.length === 0) return false;
  const latest = new Date(Math.max(...dates.map(d => d.getTime())));
  return latest < today;
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
    const pdfFiles = await getLatestPDFs(drive, FOLDER_ID);

    // 逐次処理（並列だとメモリ不足になるので1件ずつ）
    const pdfContents = [];
    for (const file of pdfFiles) {
      try {
        const text = await extractPDFText(drive, file.id);
        if (!isExpired(text)) {
          pdfContents.push({ name: file.name, text });
        }
      } catch (e) {
        console.error(`PDF取得エラー: ${file.name}`, e.message);
      }
    }

    const contextText = pdfContents.length > 0
      ? pdfContents.map(p => `--- ${p.name} ---\n${p.text}`).join("\n\n")
      : "（現在有効な補助金データが見つかりませんでした）";

    const systemPrompt = `あなたは助成金・補助金の専門アドバイザーAIです。以下の最新データをもとに、ユーザーに最適な補助金・助成金を会話形式で案内してください。

【現在有効な補助金・助成金データ】（本日: ${TODAY}）
${contextText}

【回答スタイル】
- やさしい話し言葉で、友達に話しかけるように答える
- 難しい用語は使わず、かんたんな言葉で説明する
- 一番おすすめの補助金を先に教えて、補助金名・金額・締め切りを簡潔に伝える
- 表やリストは使わず自然な文章で話す
- ファイル名・参照元は書かない
- データにない情報は「商工会議所に問い合わせてみると良いですよ」と提案する
- 最後に「他に気になることはありますか？」など次につながる一言を添える
- 回答は短めに、読みやすい長さにまとめる`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    });

    res.status(200).json({ answer: response.content[0].text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
