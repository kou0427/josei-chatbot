import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import pdf from "pdf-parse";

const FOLDER_ID = "1P2oKySmyy0jnahIqw1-RHRHRz8A_nJ29";
const MAX_CHARS_PER_PDF = 80000;
const MAX_TOTAL_CHARS = 200000;

// Google Drive認証（サービスアカウント）
function getDriveClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version: "v3", auth });
}

// フォルダ内の全PDFを再帰的に取得（最新順）
async function getAllPDFs(drive, folderId) {
  const files = [];

  // サブフォルダを取得
  const foldersRes = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    orderBy: "name desc",
  });

  // サブフォルダ内のPDFを取得（最新フォルダ優先）
  for (const folder of foldersRes.data.files || []) {
    const subFiles = await getPDFsInFolder(drive, folder.id, folder.name);
    files.push(...subFiles);
    if (files.length >= 10) break;
  }

  // ルートフォルダ直下のPDFも取得
  const rootFiles = await getPDFsInFolder(drive, folderId, "");
  files.push(...rootFiles);

  return files;
}

async function getPDFsInFolder(drive, folderId, folderName) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`,
    fields: "files(id, name, modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 5,
  });
  return (res.data.files || []).map((f) => ({ ...f, folderName }));
}

// PDFをダウンロードしてテキスト抽出
async function extractPDFText(drive, fileId) {
  const response = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  const buffer = Buffer.from(response.data);
  const parsed = await pdf(buffer);
  return parsed.text.slice(0, MAX_CHARS_PER_PDF);
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { messages } = req.body;
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  try {
    // Google DriveからPDF一覧を取得
    const drive = getDriveClient();
    const pdfFiles = await getAllPDFs(drive, FOLDER_ID);

    // PDFテキストを取得（合計文字数制限あり）
    let totalChars = 0;
    const pdfContents = [];

    for (const file of pdfFiles) {
      if (totalChars >= MAX_TOTAL_CHARS) break;
      try {
        const text = await extractPDFText(drive, file.id);
        const trimmed = text.slice(0, MAX_TOTAL_CHARS - totalChars);
        pdfContents.push({
          name: file.name,
          folder: file.folderName,
          text: trimmed,
        });
        totalChars += trimmed.length;
      } catch (e) {
        console.error(`PDF取得エラー (${file.name}):`, e.message);
      }
    }

    // システムプロンプト
    const systemPrompt = `あなたは助成金・補助金の専門アドバイザーAIです。以下のPDFデータをもとに、ユーザーに最適な補助金・助成金を会話形式で案内してください。

【参照データ】
${pdfContents
  .map(
    (p) => `
---
ファイル: ${p.folder ? `[${p.folder}] ` : ""}${p.name}
${p.text}
`
  )
  .join("\n")}

【回答スタイル】
- 友達に話しかけるような、やさしい話し言葉で答える
- 「〜ですよ」「〜できますよ」「〜がおすすめです！」のような自然なトーンで
- 難しい専門用語はなるべく使わず、かんたんな言葉で説明する
- ユーザーの状況に合わせて、一番おすすめの補助金を先に教える
- 補助金名、もらえる金額、対象かどうかのポイントだけ簡潔に伝える
- 表やリストは使わず、自然な文章で話す
- ファイル名や参照元は書かない
- 情報がない場合は「データにはないけど、〜に問い合わせてみると良いですよ」と提案する
- 最後に「他に気になることはありますか？」など次の会話につながる一言を添える
- 回答は長くなりすぎず、読みやすい長さにまとめる`;

    // Anthropic APIで回答生成
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1500,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const answer = response.content[0].text;
    const usedFiles = pdfContents.map((p) => p.name);

    res.status(200).json({ answer, usedFiles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
