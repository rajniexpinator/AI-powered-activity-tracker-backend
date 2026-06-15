/**
 * Local Teams notification debugger — no login token required.
 * Usage (from Backend folder):
 *   npm run debug:teams
 *   npm run debug:teams -- test@apexquality.net
 */
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '..', '.env') })

const recipient = (process.argv[2] || 'test@apexquality.net').trim().toLowerCase()
const sender = (process.env.MS365_TEAMS_SENDER || process.env.MS365_SENDER || '').trim().toLowerCase()
const clientId = process.env.AZURE_CLIENT_ID || ''

const { diagnoseTeamsSetup, sendTeamsChatMessages } = await import('../src/services/msGraphTeams.js')

function printReport(report) {
  console.log('\n=== Teams debug report ===')
  console.log(`Azure Client ID: ${report.azureClientId || clientId || '(missing)'}`)
  console.log(`MS365_TEAMS_SENDER: ${sender || '(missing)'}`)
  console.log(`Test recipient: ${recipient}`)
  console.log('')
  for (const s of report.steps || []) {
    const mark = s.ok ? 'OK  ' : 'FAIL'
    console.log(`[${mark}] ${s.step}`)
    console.log(`       ${s.detail}`)
    if (s.likelyFix) console.log(`       → ${s.likelyFix}`)
  }
  if (report.policyHelp) {
    console.log('\nPolicy help:', report.policyHelp)
  }
}

async function main() {
  if (!clientId) {
    console.error('AZURE_CLIENT_ID missing in .env')
    process.exit(1)
  }
  if (!sender) {
    console.error('MS365_TEAMS_SENDER missing in .env')
    process.exit(1)
  }
  if (sender === recipient) {
    console.error('Recipient cannot be the same as MS365_TEAMS_SENDER. Pass a different email:')
    console.error('  node scripts/debug-teams.mjs test@apexquality.net')
    process.exit(1)
  }

  const report = await diagnoseTeamsSetup(recipient)
  printReport(report)

  const createStep = report.steps?.find((s) => s.step === 'create_chat')
  const sendStep = report.steps?.find((s) => s.step === 'send_message')
  if (createStep?.ok && sendStep?.ok) {
    console.log('\n=== Sending test message ===')
    try {
      await sendTeamsChatMessages({
        recipientEmail: recipient,
        messages: [`Activity Tracker debug test — ${new Date().toISOString()}`],
      })
      console.log(`SUCCESS: message sent to ${recipient}. Check Teams.`)
    } catch (err) {
      console.error('FAIL send message:', err?.message || err)
      process.exit(1)
    }
  } else {
    console.log('\nStopped before send — fix the failed step above first.')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err?.message || err)
  process.exit(1)
})
