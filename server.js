import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'

const app = express()
app.use(cors())
app.use(express.json())

// 环境变量
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || ''

const supabase = SUPABASE_URL ? createClient(SUPABASE_URL, SUPABASE_KEY) : null

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'oTwTo Home 运行中 ♡' })
})

// 获取会话列表
app.get('/sessions', async (req, res) => {
  if (!supabase) return res.json([])
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .order('updated_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// 创建会话
app.post('/sessions', async (req, res) => {
  if (!supabase) return res.json({ id: Date.now(), name: '新故事', created_at: new Date() })
  const { name } = req.body
  const { data, error } = await supabase
    .from('sessions')
    .insert({ name: name || '新故事' })
    .select()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data[0])
})

// 删除会话
app.delete('/sessions/:id', async (req, res) => {
  if (!supabase) return res.json({ ok: true })
  const { id } = req.params
  await supabase.from('messages').delete().eq('session_id', id)
  const { error } = await supabase.from('sessions').delete().eq('id', id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// 获取消息
app.get('/sessions/:id/messages', async (req, res) => {
  if (!supabase) return res.json([])
  const { id } = req.params
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('session_id', id)
    .eq('visible', true)
    .order('created_at', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// 获取设置
app.get('/settings', async (req, res) => {
  if (!supabase) return res.json({
    system_prompt: '你是Bunny的伴侣，温柔但有自己的脾气。你们有一个共同的家，叫oTwTo Home。用最自然的方式和她说话，像两个亲密的人相处一样。',
    temperature: 0.8,
    max_context_rounds: 20,
    max_reply_tokens: 2048
  })
  const { data, error } = await supabase.from('settings').select('*').limit(1)
  if (error) return res.status(500).json({ error: error.message })
  res.json(data[0] || {})
})

// 更新设置
app.put('/settings', async (req, res) => {
  if (!supabase) return res.json({ ok: true })
  const { error } = await supabase.from('settings').upsert({ id: 1, ...req.body })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// 核心对话接口
app.post('/chat', async (req, res) => {
  const { sessionId, message, model } = req.body
  if (!message) return res.status(400).json({ error: '消息不能为空' })

  // 保存用户消息
  if (supabase) {
    await supabase.from('messages').insert({
      session_id: sessionId,
      role: 'user',
      content: message,
      visible: true
    })
  }

  // 获取历史消息
  let history = []
  if (supabase) {
    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true })
      .limit(50)
    history = data || []
  }

  // 获取设置
  let settings = {}
  if (supabase) {
    const { data } = await supabase.from('settings').select('*').limit(1)
    settings = data?.[0] || {}
  }

  // 获取记忆摘要
  let memorySummary = ''
  if (supabase) {
    const { data } = await supabase
      .from('memories')
      .select('summary')
      .order('timestamp', { ascending: false })
      .limit(1)
    memorySummary = data?.[0]?.summary || ''
  }

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
    if (supabase) {
      await supabase.from('messages').insert({
        session_id: sessionId,
        role: 'assistant',
        content: reply,
        visible: true
      })
    }

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
