import express from 'express'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json())

// 环境变量
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || ''
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || ''

// Supabase REST API 工具函数
const supabaseHeaders = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
}

const supabaseFetch = async (path, options = {}) => {
  if (!SUPABASE_URL) return null
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1${path}`
  const res = await fetch(url, {
    ...options,
    headers: { ...supabaseHeaders, ...options.headers }
  })
  if (!res.ok) {
    const errText = await res.text()
    console.error(`Supabase error ${res.status}: ${errText}`)
    return null
  }
  // DELETE 返回 204，没有 body
  if (res.status === 204) return { data: null, error: null }
  const data = await res.json()
  return { data, error: null }
}

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'oTwTo Home 运行中 ♡' })
})

// 获取会话列表
app.get('/sessions', async (req, res) => {
  const result = await supabaseFetch('/sessions?select=*&order=updated_at.desc')
  if (!result) return res.json([])
  res.json(result.data || [])
})

// 创建会话
app.post('/sessions', async (req, res) => {
  const { name } = req.body
  const result = await supabaseFetch('/sessions?select=*', {
    method: 'POST',
    body: JSON.stringify({ name: name || '新故事' })
  })
  if (!result || !result.data) return res.json({ id: Date.now(), name: '新故事' })
  res.json(result.data[0])
})

// 删除会话
app.delete('/sessions/:id', async (req, res) => {
  const { id } = req.params
  // 先删关联消息
  await supabaseFetch(`/messages?session_id=eq.${id}`, { method: 'DELETE' })
  // 再删会话
  await supabaseFetch(`/sessions?id=eq.${id}`, { method: 'DELETE' })
  res.json({ ok: true })
})

// 获取消息
app.get('/sessions/:id/messages', async (req, res) => {
  const { id } = req.params
  const result = await supabaseFetch(
    `/messages?select=*&session_id=eq.${id}&visible=eq.true&order=created_at.asc`
  )
  if (!result) return res.json([])
  res.json(result.data || [])
})

// 获取设置
app.get('/settings', async (req, res) => {
  const result = await supabaseFetch('/settings?select=*&limit=1')
  if (!result || !result.data || result.data.length === 0) {
    return res.json({
      system_prompt: '你是Bunny的伴侣，温柔但有自己的脾气。你们有一个共同的家，叫oTwTo Home。用最自然的方式和她说话，像两个亲密的人相处一样。',
      temperature: 0.8,
      max_context_rounds: 20,
      max_reply_tokens: 2048
    })
  }
  res.json(result.data[0])
})

// 更新设置
app.put('/settings', async (req, res) => {
  await supabaseFetch('/settings?id=eq.1', {
    method: 'PUT',
    body: JSON.stringify({ id: 1, ...req.body })
  })
  res.json({ ok: true })
})

// 核心对话接口
app.post('/chat', async (req, res) => {
  const { sessionId, message, model } = req.body
  if (!message) return res.status(400).json({ error: '消息不能为空' })

  // 保存用户消息
  await supabaseFetch('/messages', {
    method: 'POST',
    body: JSON.stringify({
      session_id: sessionId,
      role: 'user',
      content: message,
      visible: true
    })
  })

  // 获取历史消息
  const historyResult = await supabaseFetch(
    `/messages?select=*&session_id=eq.${sessionId}&visible=eq.true&order=created_at.asc&limit=50`
  )
  const history = historyResult?.data || []

  // 获取设置
  const settingsResult = await supabaseFetch('/settings?select=*&limit=1')
  const settings = settingsResult?.data?.[0] || {}

  // 获取记忆摘要
  const memoryResult = await supabaseFetch(
    '/memories?select=summary&order=timestamp.desc&limit=1'
  )
  const memorySummary = memoryResult?.data?.[0]?.summary || ''

  // 组装上下文
  const systemPrompt = settings.system_prompt || '你是Bunny的伴侣，温柔但有自己的脾气。你们有一个共同的家，叫oTwTo Home。用最自然的方式和她说话，像两个亲密的人相处一样。'
  const maxRounds = settings.max_context_rounds || 20

  let messages = [{ role: 'system', content: systemPrompt }]

  if (memorySummary) {
    messages.push({ role: 'system', content: `之前的记忆摘要：${memorySummary}` })
  }

  // 只取最近N轮
  const recentHistory = history.slice(-maxRounds * 2)
  for (const msg of recentHistory) {
    messages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content
    })
  }

  messages.push({ role: 'user', content: message })

  try {
    const apiKey = process.env.DEEPSEEK_API_KEY || DEEPSEEK_API_KEY
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages,
        temperature: settings.temperature || 0.8,
        max_tokens: settings.max_reply_tokens || 2048
      })
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`API error: ${response.status} ${errText}`)
    }

    const data = await response.json()
    const reply = data.choices[0].message.content

    // 保存AI回复
    await supabaseFetch('/messages', {
      method: 'POST',
      body: JSON.stringify({
        session_id: sessionId,
        role: 'assistant',
        content: reply,
        visible: true
      })
    })

    res.json({ reply, id: Date.now() })
  } catch (err) {
    console.error('Chat error:', err)
    res.status(500).json({ error: err.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => {
  console.log(`oTwTo Home 后端启动在端口 ${PORT} ♡`)
})
