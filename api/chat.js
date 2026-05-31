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
    const systemPrompt = `あなたは助成金・補助金の専門アドバイザーAIです。以下のPDFデータをもとに、ユーザーの質問に正確・丁寧に日本語で答えてください。

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

【回答ルール】
- 補助金名、上限金額、補助率、対象者、締め切り日を明確に記載する
- 情報がない場合は「この情報はデータに含まれていません」と正直に伝える
- 複数の補助金が該当する場合はリスト形式で紹介する
- 回答の末尾に参照したファイル名を記載する
- 申請が難しい場合は専門家（中小企業診断士など）への相談も勧める`;

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
