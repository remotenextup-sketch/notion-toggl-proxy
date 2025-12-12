// api/proxy.js (最終安定版: ハングアップ回避と認証情報の分離)
const axios = require('axios'); // axiosの利用は必須です。

module.exports = async function (req, res) {
    // 1. CORSヘッダー設定 (Vercelの設定と合わせる)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Notion-Version');

    // 2. OPTIONSリクエストの処理（プリフライト）
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    
    // 3. POST/PATCHリクエストの処理
    
    // Vercelが自動でパースしたリクエストボディを取得
    const body = req.body || {}; 
    const { targetUrl, method, tokenKey, tokenValue, notionVersion, body: apiBody } = body;

    // 必須パラメーターのチェック（これが欠けると 400 を返す）
    if (!targetUrl || !tokenKey || !tokenValue) {
        console.error('Missing targetUrl, tokenKey, or tokenValue in request body.');
        return res.status(400).json({ 
            message: 'Missing targetUrl or tokenValue in request body payload.' 
        });
    }

    try {
        let headers = {};
        
        // 認証ヘッダーの構築
        if (tokenKey === 'notionToken') {
            headers = {
                'Authorization': `Bearer ${tokenValue}`,
                'Notion-Version': notionVersion || '2022-06-28'
            };
        } else if (tokenKey === 'togglApiToken') {
            const base64Auth = Buffer.from(`${tokenValue}:api_token`).toString('base64');
            headers = {
                'Authorization': `Basic ${base64Auth}`
            };
        }
        
        // Content-Type ヘッダーの追加 (Notion/Toggl API用)
        if (method === 'POST' || method === 'PATCH') {
            headers['Content-Type'] = 'application/json';
        }

        // 外部APIへリクエストを転送
        const apiRes = await axios({
            url: targetUrl,
            method: method,
            headers: headers,
            data: apiBody 
        });

        // 外部APIからの応答をクライアントに返す
        res.status(apiRes.status).send(apiRes.data);

    } catch (error) {
        // エラーが発生した場合も必ず応答を返す（ハングアップ回避）
        const status = error.response ? error.response.status : 500;
        const data = error.response ? error.response.data : { message: 'Proxy internal error' };
        
        console.error('API call failed:', error.message);
        
        res.status(status).json(data);
    }
};
