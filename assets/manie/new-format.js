#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const inquirer = require('inquirer');

// File paths
const SMS_FORMATS_PATH = path.join(__dirname, 'sms-formats.json');

// Generate new version
function generateNewVersion(currentVersion) {
  const today = new Date();
  const dateStr = today.getFullYear().toString() +
                  (today.getMonth() + 1).toString().padStart(2, '0') +
                  today.getDate().toString().padStart(2, '0');

  const baseVersion = `regex-v${dateStr}`;

  if (currentVersion === baseVersion) {
    // Find the next available number
    let counter = 1;
    while (counter <= 999) {
      const newVersion = `${baseVersion}-${counter}`;
      counter++;
      if (counter > 999) break; // Safety check
    }
    return `${baseVersion}-${counter - 1}`;
  }

  return baseVersion;
}

// Minify JSON
function minifyJSON(obj) {
  return JSON.stringify(obj, null, 0);
}

// Main function
async function main() {
  console.log('🎯 SMS Format Creator');
  console.log('===================');

  try {
    // Read current SMS formats
    if (!fs.existsSync(SMS_FORMATS_PATH)) {
      console.error('❌ sms-formats.json not found!');
      process.exit(1);
    }

    const smsFormatsData = JSON.parse(fs.readFileSync(SMS_FORMATS_PATH, 'utf8'));

    // Generate new version
    const newVersion = generateNewVersion(smsFormatsData.version);
    console.log(`📅 New version will be: ${newVersion}\n`);

    // Basic Information
    const basicInfo = await inquirer.prompt([
      {
        type: 'input',
        name: 'id',
        message: 'Pattern ID:',
        validate: (input) => input.trim() ? true : 'Pattern ID is required'
      },
      {
        type: 'list',
        name: 'carrier',
        message: 'Carrier:',
        choices: ['mtn', 'airtel']
      },
      {
        type: 'list',
        name: 'locale',
        message: 'Locale:',
        choices: ['en-RW', 'rw-RW', 'en-UG', 'fr-RW']
      },
      {
        type: 'list',
        name: 'type',
        message: 'Type:',
        choices: ['transfer', 'receive', 'payment', 'withdraw', 'deposit']
      }
    ]);

    // Regex Pattern
    const regexInfo = await inquirer.prompt([
      {
        type: 'input',
        name: 'pattern',
        message: 'Regex pattern (use \\d+ for numbers, \\s+ for spaces):',
        validate: (input) => input.trim() ? true : 'Pattern is required'
      },
      {
        type: 'input',
        name: 'flags',
        message: 'Regex flags (i/g/m or leave empty):',
        default: ''
      }
    ]);

    // Capture Map - Required fields
    const requiredFields = await inquirer.prompt([
      {
        type: 'input',
        name: 'amount',
        message: 'Amount capture group number:',
        validate: (input) => {
          if (!input || (typeof input === 'string' && !input.trim())) return 'Amount capture group is required';
          const num = parseInt(input);
          return !isNaN(num) && num > 0 ? true : 'Must be a valid number';
        },
        filter: (input) => input ? parseInt(input) : input
      },
      {
        type: 'input',
        name: 'balance',
        message: 'Balance capture group number:',
        validate: (input) => {
          if (!input || (typeof input === 'string' && !input.trim())) return 'Balance capture group is required';
          const num = parseInt(input);
          return !isNaN(num) && num > 0 ? true : 'Must be a valid number';
        },
        filter: (input) => input ? parseInt(input) : input
      }
    ]);

    // Capture Map - Optional fields
    const optionalFieldsConfig = [
      { key: 'secondParty', message: 'Second party capture group (leave empty to skip):' },
      { key: 'accountNumber', message: 'Account number capture group (leave empty to skip):' },
      { key: 'fee', message: 'Fee capture group (leave empty to skip):' },
      { key: 'transactionId', message: 'Transaction ID capture group (leave empty to skip):' },
      { key: 'agentName', message: 'Agent name capture group (leave empty to skip):' },
      { key: 'agentNumber', message: 'Agent number capture group (leave empty to skip):' }
    ];

    const optionalFields = {};
    for (const field of optionalFieldsConfig) {
      const answer = await inquirer.prompt([
        {
          type: 'input',
          name: 'value',
          message: field.message,
          validate: (input) => {
            if (!input || !String(input).trim()) return true; // Empty is valid (optional)
            if (String(input).includes(':')) return true; // String mapping is valid
            const num = parseInt(input);
            return !isNaN(num) && num > 0 ? true : 'Must be a valid number or leave empty';
          },
          filter: (input) => {
            if (!input || !String(input).trim()) return '';
            if (String(input).includes(':')) return input;
            return parseInt(input);
          }
        }
      ]);

      if (answer.value !== '' && answer.value !== null && answer.value !== undefined) {
        optionalFields[field.key] = answer.value;
      }
    }

    // Timestamp Information
    const timestampInfo = await inquirer.prompt([
      {
        type: 'input',
        name: 'group',
        message: 'Timestamp capture group number:',
        validate: (input) => {
          if (!input || (typeof input === 'string' && !input.trim())) return 'Timestamp capture group is required';
          const num = parseInt(input);
          return !isNaN(num) && num > 0 ? true : 'Must be a valid number';
        },
        filter: (input) => input ? parseInt(input) : input
      },
      {
        type: 'list',
        name: 'parser',
        message: 'Timestamp parser:',
        choices: ['iso8601', 'airtel-shortcode']
      }
    ]);

    // Tags - checkbox with custom option
    const predefinedTags = ['transfer', 'receive', 'payment', 'withdraw', 'deposit', 'merchant', 'token', 'airtel', 'mtn'];
    const tagsAnswer = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selected',
        message: 'Select tags (use spacebar to select):',
        choices: predefinedTags
      },
      {
        type: 'input',
        name: 'custom',
        message: 'Additional custom tags (comma-separated, leave empty if none):',
        filter: (input) => input.split(',').map(tag => tag.trim()).filter(tag => tag)
      }
    ]);

    const tags = [...tagsAnswer.selected, ...tagsAnswer.custom];

    // Status
    const statusAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'status',
        message: 'Status:',
        choices: ['active', 'inactive', 'draft'],
        default: 'active'
      }
    ]);

    // Build the pattern object
    const now = new Date().toISOString();
    const pattern = {
      id: basicInfo.id,
      carrier: basicInfo.carrier,
      locale: basicInfo.locale,
      type: basicInfo.type,
      pattern: regexInfo.pattern,
      flags: regexInfo.flags,
      captureMap: {
        amount: requiredFields.amount,
        balance: requiredFields.balance,
        ...optionalFields
      },
      timestamp: {
        group: timestampInfo.group,
        parser: timestampInfo.parser
      },
      tags: tags,
      status: statusAnswer.status,
      createdAt: now,
      updatedAt: now
    };

    // Confirm before adding
    console.log('\n✅ Pattern Summary');
    console.log('-----------------');
    console.log(JSON.stringify(pattern, null, 2));

    const confirm = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'proceed',
        message: 'Add this pattern?',
        default: false
      }
    ]);

    if (!confirm.proceed) {
      console.log('❌ Pattern not added.');
      return;
    }

    // Update SMS formats
    smsFormatsData.version = newVersion;
    smsFormatsData.fetchedAt = now;
    smsFormatsData.patterns.push(pattern);

    // Write back to file (minified)
    fs.writeFileSync(SMS_FORMATS_PATH, minifyJSON(smsFormatsData));

    console.log(`\n🎉 Pattern "${pattern.id}" added successfully!`);
    console.log(`📁 Updated sms-formats.json with version ${newVersion}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// Run the script
main();
