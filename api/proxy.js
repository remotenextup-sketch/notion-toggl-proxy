const { Client } = require('@notionhq/client');
const fetch = require('node-fetch');

// =========================================================
// Toggl 関連のヘルパー関数
// =========================================================

/**
 * 実行中のTogglタイムエントリーがあれば停止します。
 * @param {string} token Toggl APIトークン
 * @returns {Promise<object|null>} 停止されたエントリー、またはnull
 */
async function stopRunningTogglEntry(token) {
    const authHeader = 'Basic ' + Buffer.from(`${token}:api_token`).toString('base64');
    const currentEntryUrl = 'https://api.track.toggl.com/api/v9/me/time_entries/current';
    
    // 現在実行中のエントリーを取得
    const currentEntryResponse = await fetch(currentEntryUrl, {
        method: 'GET',
        headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json'
        }
    });

    if (currentEntryResponse.status === 204) {
        return null;
    }
    
    if (!currentEntryResponse.ok) {
        throw new Error(`Toggl API error (GET /current): ${currentEntryResponse.statusText}`);
    }
    
    const currentEntry = await currentEntryResponse.json();
    
    if (currentEntry && currentEntry.id) {
        // 実行中のエントリがあれば停止APIを呼び出す
        const stopUrl = `https://api.track.toggl.com/api/v9/time_entries/${currentEntry.id}/stop`;
        await fetch(stopUrl, {
            method: 'PATCH',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            }
        });
        return currentEntry;
    }
    return null;
}

// =========================================================
// メインのエクスポート関数 (Vercelサーバーレス関数)
// =========================================================

module.exports = async (req, res) => {
    // ★★★ CORS設定を最も強力な形に強化 ★★★
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true'); // クレデンシャルを許可

    if (req.method === 'OPTIONS') {
        // プリフライトリクエストをここで正常終了させる
        return res.status(200).end();
    }

    // リクエストボディのパース
    const { 
        targetUrl, method, body, tokenKey, tokenValue,
        customEndpoint, dbId, dataSourceId, workspaceId, description
    } = req.body;

    // トークンが提供されていない場合のエラーハンドリング
    if (!tokenValue) {
        return res.status(401).json({ message: 'Token value missing in request body.' });
    }

    try {
        // ===============================================
        // A. カスタムエンドポイントの処理
        // ===============================================
        if (customEndpoint) {
            
            // ---------------------------------------------
            // A-1. DBプロパティ設定取得 (getConfig)
            // ---------------------------------------------
            if (customEndpoint === 'getConfig') {
                if (!dbId) {
                    return res.status(400).json({ code: 'missing_db_id', message: 'Database ID is required for getConfig.' });
                }
                const notion = new Client({ auth: tokenValue });
                const database = await notion.databases.retrieve({ database_id: dbId });

                const properties = database.properties;
                const categories = properties['カテゴリ']?.select?.options?.map(opt => opt.name) || [];
                const departments = properties['部門']?.multi_select?.options?.map(opt => opt.name) || [];

                const match = database.url.match(/notion\.so\/([a-f0-9]+)\/([a-f0-9]+)/);
                const dataSourceIdFromUrl = match ? match[1] : null;

                return res.status(200).json({ categories, departments, dataSourceId: dataSourceIdFromUrl });
            }

            // ---------------------------------------------
            // A-2. Toggl計測開始 (startTogglTracking) 
            // ---------------------------------------------
            else if (customEndpoint === 'startTogglTracking') {
                
                if (!workspaceId || !description) {
                    return res.status(400).json({ message: 'Toggl parameters missing (workspaceId or description).' });
                }

                // 1. 既存の計測を停止 
                await stopRunningTogglEntry(tokenValue); 

                // 2. 新しいタイムエントリーを開始
                const authHeader = 'Basic ' + Buffer.from(`${tokenValue}:api_token`).toString('base64');
                const startEntryUrl = 'https://api.track.toggl.com/api/v9/time_entries';
                
                // workspaceIdを必ず数値に変換する
                const numericWorkspaceId = parseInt(workspaceId, 10);
                if (isNaN(numericWorkspaceId)) {
                    return res.status(400).json({ message: 'Invalid workspaceId format.' });
                }

                const newEntryResponse = await fetch(startEntryUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': authHeader,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        description: description,
                        workspace_id: numericWorkspaceId, // 変換済みの数値を使用
                        created_with: 'NotionTogglTimerApp',
                        start: new Date().toISOString(),
                        duration: -1
                    })
                });

                if (!newEntryResponse.ok) {
                    const errorText = await newEntryResponse.text();
                    console.error('Toggl Start Error:', newEntryResponse.status, errorText);
                    return res.status(newEntryResponse.status).json({ message: 'Failed to start Toggl entry', details: errorText });
                }

                const newEntry = await newEntryResponse.json();
                return res.status(200).json(newEntry);
            }
            
            // ---------------------------------------------
            // A-3. KPIデータ取得 (getKpi)
            // ---------------------------------------------
            else if (customEndpoint === 'getKpi') {
                if (!dataSourceId) {
                    return res.status(400).json({ code: 'missing_data_source_id', message: 'Data Source ID is required for getKpi.' });
                }
                const notion = new Client({ auth: tokenValue });
                
                const databaseId = dataSourceId; 
                
                const now = new Date();
                const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000)).toISOString().split('T')[0];
                
                // 完了タスクを取得 (30日フィルターは適用せず、全件取得)
                const response = await notion.databases.query({
                    database_id: databaseId,
                    filter: {
                        property: 'ステータス',
                        status: { equals: '完了' }
                    }
                });
                
                let totalWeekMins = 0;
                let totalMonthMins = 0;
                const categoryWeekMins = {};

                const oneWeekAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
                
                response.results.forEach(page => {
                    const timeProperty = '時間'; 
                    const timeProp = page.properties[timeProperty]?.formula?.number; 
                    const completedDate = page.properties['完了日']?.date?.start;
                    const category = page.properties['カテゴリ']?.select?.name;

                    if (timeProp) {
                        const mins = Math.round(timeProp * 60); 
                        
                        // 週間集計
                        if (completedDate && new Date(completedDate) >= oneWeekAgo) {
                            totalWeekMins += mins;
                            if (category) {
                                categoryWeekMins[category] = (categoryWeekMins[category] || 0) + mins;
                            }
                        }
                    }
                    
                    // 月間集計 (30日以内でフィルタリング)
                    if (completedDate && new Date(completedDate) >= new Date(thirtyDaysAgo)) {
                        const timeProp = page.properties[timeProperty]?.formula?.number;
                        if (timeProp) {
                             const mins = Math.round(timeProp * 60);
                             totalMonthMins += mins;
                        }
                    }
                });

                return res.status(200).json({ totalWeekMins, totalMonthMins, categoryWeekMins });
            }
            
            // ---------------------------------------------
            // A-4. 未定義のエンドポイント
            // ---------------------------------------------
            else {
                return res.status(400).json({ message: 'Invalid custom endpoint.' });
            }
        }

        // ===============================================
        // B. Notion/Togglへの直接プロキシ処理
        // ===============================================
        else if (targetUrl) {
            
            const isNotion = tokenKey === 'notionToken';
            const isToggl = tokenKey === 'togglApiToken';
            
            let authHeader;
            if (isNotion) {
                authHeader = `Bearer ${tokenValue}`;
            } else if (isToggl) {
                authHeader = 'Basic ' + Buffer.from(`${tokenValue}:api_token`).toString('base64');
            } else {
                return res.status(400).json({ message: 'Invalid token key.' });
            }

            const notionVersion = '2022-06-28'; 
            
            const fetchOptions = {
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': authHeader,
                },
            };
            
            if (isNotion) {
                fetchOptions.headers['Notion-Version'] = notionVersion;
            }

            if (method !== 'GET' && method !== 'HEAD' && body) {
                fetchOptions.body = JSON.stringify(body);
            }

            const response = await fetch(targetUrl, fetchOptions);
            
            const responseBody = await response.text();
            
            res.status(response.status).send(responseBody);
            
        } 
        
        // ===============================================
        // C. 不正なリクエスト
        // ===============================================
        else {
            return res.status(400).json({ message: 'Invalid request format. Missing targetUrl or customEndpoint.' });
        }

    } catch (error) {
        console.error('Proxy Error:', error);
        return res.status(500).json({ message: 'Internal Server Error', details: error.message });
    }
};
