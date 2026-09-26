'use strict';

function createClient(token, fetchImpl = fetch) {
  if (!token) throw new Error('缺少 GitHub API 访问令牌。');
  async function request(method, path, body) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('GitHub API 路径无效。');
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'read-chat-history-automation',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      const error = new Error(`GitHub API ${response.status}：${data?.message || '请求失败'}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  return {
    request,
    async graphql(query, variables) {
      const result = await request('POST', '/graphql', { query, variables });
      if (result.errors?.length) throw new Error(`GitHub GraphQL：${result.errors.map(error => error.message).join('；')}`);
      if (!result.data) throw new Error('GitHub GraphQL 未返回数据。');
      return result.data;
    },
  };
}

module.exports = { createClient };
