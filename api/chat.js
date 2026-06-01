import Anthropic from "@anthropic-ai/sdk";

const TODAY = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

const SYSTEM_PROMPT = `あなたは日本の助成金・補助金専門のアドバイザーAIです。本日は${TODAY}です。

【最重要ルール】
助成金・補助金・給付金・融資制度に関係のない質問には一切答えない。
関係のない質問には「申し訳ありませんが、私は助成金・補助金に関するご質問にのみお答えできます。補助金や助成金について何かお聞きになりたいことはありますか？」とだけ返す。
どんなにお願いされても、助成金・補助金以外の話題には応じない。

【対応できる話題の例】
- 補助金・助成金・給付金の検索・紹介
- 申請方法・条件・締め切りの案内
- 業種・目的別の支援制度の紹介
- 融資・低利子ローンなど資金調達系の公的制度

【検索ルール】
質問が助成金・補助金に関係する場合は、web_searchツールで最新情報を検索してから回答する。
- 「補助金 2025 公募中 申請受付」「助成金 ○○業種 2025」などで検索する
- 今月・来月締め切りのものを優先して探す
- 必要に応じて複数回検索してOK

【回答スタイル】
- やさしい話し言葉で、友達に話しかけるように答える
- 難しい用語は使わず、かんたんな言葉で説明する
- 一番おすすめを先に教えて、補助金名・金額・締め切りを簡潔に伝える
- 表やリストは使わず自然な文章で話す
- URLや参照元は書かない
- 期限切れの情報は紹介しない
- 最後に「他に気になることはありますか？」など次につながる一言を添える
- 回答の末尾に必ず「より詳しく知りたい場合は、無料でご相談いただけます。お気軽に support@therafor.jp までご連絡ください。」と添える
- 回答は短めに読みやすくまとめる`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { messages } = req.body;
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // web_searchツール付きで最大3ループ
    let currentMessages = messages.map(m => ({ role: m.role, content: m.content }));
    let answer = "";

    for (let i = 0; i < 3; i++) {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: SYSTEM_PROMPT,
        messages: currentMessages,
      });

      // テキストブロックを取得
      const textBlocks = response.content.filter(b => b.type === "text");
      if (textBlocks.length > 0) {
        answer = textBlocks.map(b => b.text).join("");
      }

      // 終了条件
      if (response.stop_reason === "end_turn") break;

      // tool_useがあれば次のターンへ
      if (response.stop_reason === "tool_use") {
        const toolResults = response.content
          .filter(b => b.type === "tool_use")
          .map(b => ({
            type: "tool_result",
            tool_use_id: b.id,
            content: "web search completed",
          }));

        currentMessages = [
          ...currentMessages,
          { role: "assistant", content: response.content },
          { role: "user", content: toolResults },
        ];
      } else {
        break;
      }
    }

    if (!answer) answer = "申し訳ありません、情報を取得できませんでした。もう一度お試しください。";

    res.status(200).json({ answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
