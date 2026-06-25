import { Router } from 'express'
import { protectRoute, requireRole } from '../middleware/auth.js'
import { isDbConnected } from '../config/db.js'
import { Ms365RecipientConfig } from '../models/Ms365RecipientConfig.js'
import { getDefaultMs365Recipients } from '../services/ms365Recipients.js'
import { isMsGraphConfigured, createMs365Draft, sendMs365Draft, sendMs365Mail } from '../services/msGraphMail.js'
import { isTeamsChatConfigured, sendTeamsChatMessages, diagnoseTeamsSetup } from '../services/msGraphTeams.js'
import { createChatCompletion, getAssistantContent } from '../services/openai.js'
import { Report } from '../models/Report.js'
import { renderWeeklyReportPdf } from '../services/reportPdf.js'
import { buildQualityReportTitle, safeQualityReportFilename } from '../services/reportTitle.js'
import { resolveSharePreferences } from '../constants/sharePreferences.js'

const router = Router()

function normalizeEmailList(value) {
  if (!value) return []
  const arr = Array.isArray(value) ? value : [value]
  return arr
    .filter((v) => typeof v === 'string')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
}

async function getDefaultRecipients() {
  return getDefaultMs365Recipients()
}

router.get('/status', protectRoute, requireRole('admin'), async (_req, res) => {
  res.json({
    configured: isMsGraphConfigured(),
    dbConnected: isDbConnected(),
  })
})

// Default recipients are readable by any authenticated user so employees can send emails,
// but only admins can update them via PUT.
router.get('/recipients/default', protectRoute, async (_req, res, next) => {
  try {
    const recipients = await getDefaultRecipients()
    res.json({ recipients })
  } catch (err) {
    next(err)
  }
})

router.put('/recipients/default', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ error: 'Database not connected; cannot store default recipients' })
    }
    const { to, cc } = req.body || {}
    const update = {
      to: normalizeEmailList(to),
      cc: normalizeEmailList(cc),
    }
    const doc = await Ms365RecipientConfig.findOneAndUpdate(
      { key: 'default' },
      { $set: update },
      { new: true, upsert: true }
    ).lean()
    res.json({ recipients: { to: doc.to, cc: doc.cc } })
  } catch (err) {
    next(err)
  }
})

router.post('/drafts/weekly-report', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const { reportId, to, cc, subject, bodyText } = req.body || {}
    if (!reportId || typeof reportId !== 'string') {
      return res.status(400).json({ error: 'reportId is required' })
    }

    const report = await Report.findById(reportId).lean()
    if (!report) return res.status(404).json({ error: 'Report not found' })
    if (String(report.createdBy) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Forbidden — you can only draft emails for your own reports' })
    }

    const defaults = await getDefaultRecipients()
    const finalTo = normalizeEmailList(to)
    const finalCc = normalizeEmailList(cc)

    const toList = finalTo.length > 0 ? finalTo : defaults.to
    const ccList = finalCc.length > 0 ? finalCc : defaults.cc

    if (toList.length === 0) {
      return res.status(400).json({ error: 'No recipients provided. Set default recipients or pass to[] in the request.' })
    }

    const safeSubject =
      typeof subject === 'string' && subject.trim()
        ? subject.trim()
        : buildQualityReportTitle({ customer: report.customer, oem: report.oem, title: report.title })

    const prefs = resolveSharePreferences(req.user)
    const includePictures = prefs.report.includePictures
    const includeContent = prefs.report.includeContent

    const safeBodyText =
      typeof bodyText === 'string' && bodyText.trim()
        ? bodyText.trim()
        : includeContent && typeof report.content === 'string' && report.content.trim()
          ? report.content.trim()
          : 'Please see attached quality report. Let us know if you have any questions.'

    const draft = await createMs365Draft({
      to: toList,
      cc: ccList,
      subject: safeSubject,
      text: safeBodyText,
      attachments: await (async () => {
        const title = buildQualityReportTitle({
          customer: report.customer,
          oem: report.oem,
          title: report.title,
        })

        const pdf = await renderWeeklyReportPdf({
          title,
          content: report.content,
          imageGallery:
            includePictures && Array.isArray(report.imageGallery) ? report.imageGallery : [],
        })
        return [
          {
            name: safeQualityReportFilename(report),
            contentType: 'application/pdf',
            contentBytesBase64: pdf.toString('base64'),
          },
        ]
      })(),
    })

    res.status(201).json({ draft })
  } catch (err) {
    next(err)
  }
})

router.post('/drafts/:messageId/send', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const { messageId } = req.params
    if (!messageId || typeof messageId !== 'string') {
      return res.status(400).json({ error: 'messageId is required' })
    }
    await sendMs365Draft({ messageId })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

router.post('/drafts/customer-email', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const { customer, weekEnding, to, cc, extraContext } = req.body || {}

    const defaults = await getDefaultRecipients()
    const toList = normalizeEmailList(to).length ? normalizeEmailList(to) : defaults.to
    const ccList = normalizeEmailList(cc).length ? normalizeEmailList(cc) : defaults.cc

    if (!toList.length) {
      return res.status(400).json({ error: 'No recipients provided. Set default recipients or pass to[] in the request.' })
    }

    const customerName = typeof customer === 'string' && customer.trim() ? customer.trim() : 'the customer'
    const periodLabel =
      typeof weekEnding === 'string' && weekEnding.trim()
        ? `for the week ending ${weekEnding.trim()}`
        : 'for the recent period'

    const contextText =
      typeof extraContext === 'string' && extraContext.trim()
        ? extraContext.trim()
        : 'The attached report summarizes quality activities, visits, and follow-ups for this customer.'

    const system = `
You are a quality engineer writing a short, professional email to a customer.
The email will go out with a quality report attached (PDF or text).
Keep it concise (3–6 sentences), polite, and businesslike.
Do NOT invent details that aren't provided; keep wording generic.`.trim()

    const userPrompt = `
Write an email to ${customerName} ${periodLabel}.

Context about the report:
${contextText}

The email should:
- Mention the attached quality report explicitly.
- Include the week ending in the text if provided.
- Offer to answer questions or discuss any items.
- Use a neutral closing (e.g. "Best regards").

Write only the body text (no subject line, no "To:" line).`.trim()

    const completion = await createChatCompletion(
      [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
      { model: 'gpt-4o-mini', temperature: 0.4 }
    )

    const bodyText = getAssistantContent(completion)
    if (!bodyText) {
      throw new Error('AI did not return any content for the customer email draft')
    }

    const subject =
      typeof weekEnding === 'string' && weekEnding.trim()
        ? buildQualityReportTitle({ customer: customerName, oem: undefined }) +
          ` – ${weekEnding.trim()}`
        : buildQualityReportTitle({ customer: customerName })

    const draft = await createMs365Draft({
      to: toList,
      cc: ccList,
      subject,
      text: bodyText,
    })

    res.status(201).json({ draft })
  } catch (err) {
    next(err)
  }
})

router.post('/email/test-notification', protectRoute, async (req, res, next) => {
  try {
    if (!isMsGraphConfigured()) {
      return res.status(503).json({ error: 'Microsoft 365 mail is not configured on the server' })
    }

    const recipientEmail = typeof req.user?.email === 'string' ? req.user.email.trim().toLowerCase() : ''
    if (!recipientEmail) {
      return res.status(400).json({ error: 'Your account has no email address' })
    }

    const recipientName =
      typeof req.user?.name === 'string' && req.user.name.trim()
        ? req.user.name.trim()
        : recipientEmail.split('@')[0]
    const now = new Date().toLocaleString()
    const subject = 'Activity Tracker — test email alert'
    const text =
      `Activity Tracker — test email notification\n` +
      `Hi ${recipientName},\n\n` +
      `This is a test message from your profile settings. If you receive this email, severity log alerts are set up correctly.\n\n` +
      `Sent: ${now}`

    await sendMs365Mail({ to: recipientEmail, subject, text })
    res.json({ success: true, to: recipientEmail })
  } catch (err) {
    next(err)
  }
})

router.get('/teams/diagnose', protectRoute, async (req, res, next) => {
  try {
    const recipientEmail = typeof req.user?.email === 'string' ? req.user.email.trim().toLowerCase() : ''
    const report = await diagnoseTeamsSetup(recipientEmail)
    res.json(report)
  } catch (err) {
    next(err)
  }
})

router.post('/teams/test-notification', protectRoute, async (req, res, next) => {
  try {
    if (!isTeamsChatConfigured()) {
      return res.status(503).json({ error: 'Microsoft 365 Teams chat is not configured on the server' })
    }

    const recipientEmail = typeof req.user?.email === 'string' ? req.user.email.trim().toLowerCase() : ''
    if (!recipientEmail) {
      return res.status(400).json({ error: 'Your account has no email address' })
    }

    const teamsSender = (process.env.MS365_TEAMS_SENDER || process.env.MS365_SENDER || '').trim().toLowerCase()
    if (teamsSender && teamsSender === recipientEmail) {
      return res.status(400).json({
        error:
          `You are logged in as ${recipientEmail}, which is also MS365_TEAMS_SENDER. ` +
          'Teams cannot send a 1:1 chat to the same account. Log in as a different user to test, or set MS365_TEAMS_SENDER to another licensed user in .env.',
      })
    }

    const recipientName =
      typeof req.user?.name === 'string' && req.user.name.trim()
        ? req.user.name.trim()
        : recipientEmail.split('@')[0]
    const now = new Date().toLocaleString()
    const message =
      `Activity Tracker — test Teams notification\n` +
      `Hi ${recipientName},\n\n` +
      `This is a test message from your profile settings. If you see this in Teams, log alerts are set up correctly.\n\n` +
      `Sent: ${now}`

    await sendTeamsChatMessages({ recipientEmail, messages: [message] })
    res.json({ success: true, to: recipientEmail })
  } catch (err) {
    next(err)
  }
})

export { router as ms365Router }

