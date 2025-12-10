const fetch = require('node-fetch');

// Notion APIのバージョンを最新の 2025-09-03 に更新
const NOTION_VERSION = '2025-09-03';

/**
 * Notion/Toggl APIへの認証ヘッダーを生成する
 */
function getAuthHeaders(tokenKey, tokenValue) {
    const headers = { 'Content-Type': 'application/json' };
    
    if (tokenKey === 'notionToken') {
        headers['Authorization'] = `Bearer ${tokenValue}`;
        headers['Notion-Version'] = NOTION_VERSION;
    } else if (tokenKey === 'togglApiToken') {
        // Toggl v9 APIはBasic認証を使用
        headers['Authorization'] = 'Basic ' + Buffer.from(tokenValue + ':api_token').toString('base64');
    }
    return headers;
}


// =========================================================================
// 新規追加関数: database_id から data_source_id を取得し、DBメタデータと統合する
// =========================================================================

/**
 * ユーザーが入力した database_id から、必要な data_source_id および DB設定を取得する
 * (API v2025-09-03 以降の必須のディスカバリーステップ)
 */
async function getConfigAndDataSourceId(dbId, tokenValue) {
    const headers = getAuthHeaders('notionToken', tokenValue);
    
    // 1. database_id から data_sources のリストを取得
    let res = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
        method: 'GET',
        headers: headers,
    });
    
    if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(`Notion DBディスカバリーエラー (${res.status}): ${errorBody.code || '不明なエラー'}`);
    }
    
    const dbData = await res.json();
    
    // data_sources が存在しないか、空の場合はエラー
    if (!dbData.data_sources || dbData.data_sources.length === 0) {
        throw new Error('Notion DBのデータソースが見つかりません。データベースが正しく設定されているか確認してください。');
    }

    // 最初の data_source_id を使用（シンプル統合の前提）
    const dataSourceId = dbData.data_sources[0].id;

    // 2. data_source_id を使って、データソースのプロパティ（メタデータ）を取得
    res = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}`, {
        method: 'GET',
        headers: headers,
    });

    if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(`Notion Data Source取得エラー (${res.status}): ${errorBody.code || '不明なエラー'}`);
    }
    
    const dsData = await res.json();
    const config = { 
        dataSourceId: dataSourceId, // クライアントに返す
        categories: [], 
        departments: [] 
    };
    
    const props = dsData.properties || {}; // data_sourceのプロパティ
    
    // プロパティ名が正しいことを前提にオプションを抽出
    const categoryProp = props['カテゴリ'];
    if (categoryProp && categoryProp.type === 'select' && categoryProp.select.options) {
        config.categories = categoryProp.select.options.map(o => o.name);
    }
    
    const departmentProp = props['部門'];
    if (departmentProp && departmentProp.type === 'multi_select' && departmentProp.multi_select.options) {
        config.departments = departmentProp.multi_select.options.map(o => o.name);
    }
    
    // data_source_id と設定をまとめて返す
    return config;
}

// =========================================================================
// 既存の関数を data_source_id を使うように修正
// =========================================================================

/**
 * Notionから過去の計測ログを取得し、KPIを計算する
 * (API v2025-09-03: /v1/databases/:dbId/query から /v1/data_sources/:dsId/query に変更)
 */
async function getKpi(dataSourceId, tokenValue) { // 引数を dbId から dataSourceId に変更
    const headers = getAuthHeaders('notionToken', tokenValue);
    
    const today = new Date();
    const dayOfWeek = today.getDay(); 
    const diffToSunday = dayOfWeek;
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - diffToSunday);
    startOfWeek.setHours(0, 0, 0, 0);
    
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    startOfMonth.setHours(0, 0, 0, 0);
    
    const threeWeeksAgo = new Date();
    threeWeeksAgo.setDate(today.getDate() - 21);
    threeWeeksAgo.setHours(0, 0, 0, 0);

    const filter = {
        and: [
            { property: '計測時間(分)', number: { is_not_empty: true } },
            { property: '完了日', date: { on_or_after: threeWeeksAgo.toISOString().split('T')[0] } }
        ]
    };
    
    // ★ 修正点: エンドポイントを /v1/data_sources/:dataSourceId/query に変更
    const res = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ filter: filter })
    });
    
    // ... (以下のKPI計算ロジックは変更なし)

    if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(`Notion ログ取得エラー (${res.status}): ${errorBody.code || '不明なエラー'}`);
    }
    
    const data = await res.json();
    
    let totalWeekMins = 0;
    let totalMonthMins = 0;
    const categoryWeekMins = {};
    
    data.results.forEach(p => {
        const mins = p.properties['計測時間(分)']?.number || 0;
        const completeDateStr = p.properties['完了日']?.date?.start;
        const category = p.properties['カテゴリ']?.select?.name;
        
        if (mins > 0 && completeDateStr) {
            const completeDate = new Date(completeDateStr);
            
            if (completeDate >= startOfWeek) {
                totalWeekMins += mins;
                if (category) categoryWeekMins[category] = (categoryWeekMins[category] || 0) + mins;
            }
            if (completeDate >= startOfMonth) {
                totalMonthMins += mins;
            }
        }
    });

    return {
        totalWeekMins: totalWeekMins,
        totalMonthMins: totalMonthMins,
        categoryWeekMins: categoryWeekMins,
    };
}


// =========================================================================
// メインハンドラ (module.exports)
// =========================================================================

module.exports = async (req, res) => {
    
    // CORS/OPTIONS処理 (変更なし)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Notion-Version'); 
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        // ★ 修正点: POST以外にもPATCH(Notion)やGET(Toggl)を許可するように修正
        // ただし、アプリ側はPOSTで統一しているので、ここではPOST以外は許可しない
        return res.status(405).json({ message: 'Method Not Allowed.' });
    }
    
    try {
        const { targetUrl, method, body, tokenKey, tokenValue, customEndpoint, dbId, dataSourceId } = req.body;

        // --- 1. カスタムエンドポイントの処理 ---
        if (customEndpoint) {
            
            // ★ 修正点: getConfigAndDataSourceId を呼び出し
            if (customEndpoint === 'getConfig') {
                if (!dbId || !tokenValue) throw new Error('Missing dbId or tokenValue for custom endpoint.');
                // database_id から data_source_id を取得し、設定を返す
                const result = await getConfigAndDataSourceId(dbId, tokenValue);
                return res.status(200).json(result);
            } 
            
            // ★ 修正点: getKpi を dataSourceId で呼び出し
            else if (customEndpoint === 'getKpi') {
                if (!dataSourceId || !tokenValue) throw new Error('Missing dataSourceId or tokenValue for custom endpoint.');
                // data_source_id を使って KPI を計算
                const result = await getKpi(dataSourceId, tokenValue);
                return res.status(200).json(result);
            } else {
                return res.status(400).json({ message: 'Invalid custom endpoint.' });
            }
        }

        // --- 2. 標準プロキシ処理 (タスク作成、タスク更新、Toggl処理など) ---
        if (!targetUrl || !tokenValue) {
            return res.status(400).json({ message: 'Missing targetUrl or tokenValue in request body.' });
        }
        
        const headers = getAuthHeaders(tokenKey, tokenValue);

        // 実際のAPIリクエストの実行
        const fetchRes = await fetch(targetUrl, {
            method: method,
            headers: headers,
            body: body ? JSON.stringify(body) : null,
        });

        const data = await fetchRes.text();
        return res.status(fetchRes.status).send(data);

    } catch (error) {
        console.error('Proxy Error:', error.message);
        return res.status(500).json({ message: `Internal Server Error: ${error.message}` });
    }
};
