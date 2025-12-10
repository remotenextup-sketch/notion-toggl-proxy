module.exports = async (req, res) => {
  // すべてのCORSヘッダを最初に設定
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  // OPTIONSプリフライト即応答
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // body取得
    let body = {};
    if (req.body && req.body !== '') {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    }

    console.log('Proxy hit:', req.method, body.customEndpoint || body.targetUrl?.substring(0, 50));

    // テスト応答（まずこれで動くか確認）
    if (!body.targetUrl && !body.customEndpoint) {
      return res.json({ 
        status: 'Proxy OK!', 
        method: req.method,
        bodyKeys: Object.keys(body),
        timestamp: new Date().toISOString()
      });
    }

    // Notion API proxy（targetUrl指定時）
    if (body.targetUrl) {
      const { targetUrl, method = 'GET', body: requestBody, tokenKey, tokenValue } = body;
      
      const headers = {
        'Content-Type': 'application/json',
        'Notion-Version': '2025-09-03'
      };

      if (tokenKey === 'notionToken' && tokenValue) {
        headers.Authorization = `Bearer ${tokenValue}`;
      }
      if (tokenKey === 'togglApiToken' && tokenValue) {
        headers.Authorization = `Basic ${Buffer.from(tokenValue + ':api_token').toString('base64')}`;
      }

      const fetchOptions = { method: method.toUpperCase(), headers };
      if (requestBody) fetchOptions.body = JSON.stringify(requestBody);

      const response = await fetch(targetUrl, fetchOptions);
      const data = await response.text();

      let jsonData;
      try { 
        jsonData = JSON.parse(data); 
      } catch(e) { 
        jsonData = data; 
      }

      return res.status(response.status).json(jsonData);
    }

    // カスタムエンドポイント（getConfig, getKpiなど）
    if (body.customEndpoint) {
      return res.status(501).json({ 
        error: 'Custom endpoint coming soon', 
        endpoint: body.customEndpoint 
      });
    }

    res.status(400).json({ error: 'targetUrl or customEndpoint required' });

  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ 
      error: 'Proxy error', 
      message: error.message 
    });
  }
};
