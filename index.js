#!/usr/bin/env node

import { program } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { glob } from 'glob';
import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';

const VERSION = '1.0.0';

program
  .name('ai-env-gen')
  .description('Generate .env files by scanning your code for environment variables')
  .version(VERSION)
  .option('-d, --dir <path>', 'Directory to scan', '.')
  .option('-o, --output <file>', 'Output file', '.env.example')
  .option('-e, --extensions <ext>', 'File extensions', 'js,ts,jsx,tsx,mjs,cjs')
  .option('--ignore <patterns>', 'Patterns to ignore', 'node_modules/**,dist/**,build/**,.next/**')
  .option('--include-values', 'Include placeholder values')
  .option('--merge', 'Merge with existing .env.example')
  .option('--no-ai', 'Skip AI descriptions')
  .parse();

const opts = program.opts();

// Common env var patterns and their typical purposes
const ENV_PATTERNS = {
  // Auth
  'JWT_SECRET': { category: 'Auth', description: 'Secret key for JWT signing' },
  'AUTH_SECRET': { category: 'Auth', description: 'Authentication secret' },
  'SESSION_SECRET': { category: 'Auth', description: 'Session encryption secret' },
  
  // Database
  'DATABASE_URL': { category: 'Database', description: 'Database connection string' },
  'DB_HOST': { category: 'Database', description: 'Database host' },
  'DB_PORT': { category: 'Database', description: 'Database port' },
  'DB_NAME': { category: 'Database', description: 'Database name' },
  'DB_USER': { category: 'Database', description: 'Database user' },
  'DB_PASSWORD': { category: 'Database', description: 'Database password' },
  'REDIS_URL': { category: 'Database', description: 'Redis connection URL' },
  'MONGODB_URI': { category: 'Database', description: 'MongoDB connection string' },
  
  // APIs
  'OPENAI_API_KEY': { category: 'API', description: 'OpenAI API key' },
  'ANTHROPIC_API_KEY': { category: 'API', description: 'Anthropic API key' },
  'STRIPE_SECRET_KEY': { category: 'API', description: 'Stripe secret key' },
  'STRIPE_PUBLISHABLE_KEY': { category: 'API', description: 'Stripe publishable key' },
  'SENDGRID_API_KEY': { category: 'API', description: 'SendGrid API key' },
  'AWS_ACCESS_KEY_ID': { category: 'API', description: 'AWS access key' },
  'AWS_SECRET_ACCESS_KEY': { category: 'API', description: 'AWS secret key' },
  'AWS_REGION': { category: 'API', description: 'AWS region' },
  
  // URLs
  'NEXT_PUBLIC_URL': { category: 'URL', description: 'Public app URL' },
  'API_URL': { category: 'URL', description: 'API base URL' },
  'WEBHOOK_URL': { category: 'URL', description: 'Webhook endpoint URL' },
  
  // App Config
  'NODE_ENV': { category: 'Config', description: 'Environment (development/production)' },
  'PORT': { category: 'Config', description: 'Server port' },
  'LOG_LEVEL': { category: 'Config', description: 'Logging level' },
};

async function getFiles(dir, extensions) {
  const extList = extensions.split(',').map(e => e.trim());
  const patterns = extList.map(ext => `${dir}/**/*.${ext}`);
  const ignorePatterns = opts.ignore.split(',').map(p => p.trim());
  
  return glob(patterns, { ignore: ignorePatterns, nodir: true });
}

function extractEnvVars(content) {
  const envVars = new Set();
  
  // process.env.VAR_NAME
  const processEnvRegex = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  let match;
  while ((match = processEnvRegex.exec(content)) !== null) {
    envVars.add(match[1]);
  }
  
  // process.env['VAR_NAME'] or process.env["VAR_NAME"]
  const bracketRegex = /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g;
  while ((match = bracketRegex.exec(content)) !== null) {
    envVars.add(match[1]);
  }
  
  // import.meta.env.VAR_NAME (Vite)
  const metaEnvRegex = /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g;
  while ((match = metaEnvRegex.exec(content)) !== null) {
    envVars.add(match[1]);
  }
  
  // Deno.env.get('VAR_NAME')
  const denoRegex = /Deno\.env\.get\(['"]([A-Z][A-Z0-9_]*)['"]\)/g;
  while ((match = denoRegex.exec(content)) !== null) {
    envVars.add(match[1]);
  }
  
  // destructured: const { VAR_NAME } = process.env
  const destructureRegex = /const\s*\{([^}]+)\}\s*=\s*process\.env/g;
  while ((match = destructureRegex.exec(content)) !== null) {
    const vars = match[1].split(',').map(v => v.trim().split(':')[0].trim());
    vars.forEach(v => {
      if (/^[A-Z][A-Z0-9_]*$/.test(v)) envVars.add(v);
    });
  }
  
  // env() function calls (Laravel-style)
  const envFuncRegex = /\benv\(['"]([A-Z][A-Z0-9_]*)['"]/g;
  while ((match = envFuncRegex.exec(content)) !== null) {
    envVars.add(match[1]);
  }
  
  return Array.from(envVars);
}

function categorizeVars(vars) {
  const categorized = {};
  
  for (const varName of vars) {
    // Check known patterns
    const known = ENV_PATTERNS[varName];
    if (known) {
      if (!categorized[known.category]) categorized[known.category] = [];
      categorized[known.category].push({
        name: varName,
        description: known.description
      });
      continue;
    }
    
    // Infer category from name
    let category = 'Other';
    if (varName.includes('DB') || varName.includes('DATABASE') || varName.includes('MONGO') || varName.includes('REDIS') || varName.includes('POSTGRES')) {
      category = 'Database';
    } else if (varName.includes('API') || varName.includes('KEY') || varName.includes('SECRET') || varName.includes('TOKEN')) {
      category = 'API';
    } else if (varName.includes('URL') || varName.includes('HOST') || varName.includes('ENDPOINT')) {
      category = 'URL';
    } else if (varName.includes('AUTH') || varName.includes('JWT') || varName.includes('SESSION')) {
      category = 'Auth';
    } else if (varName.startsWith('NEXT_PUBLIC') || varName.startsWith('VITE_') || varName.startsWith('REACT_APP_')) {
      category = 'Client';
    }
    
    if (!categorized[category]) categorized[category] = [];
    categorized[category].push({
      name: varName,
      description: null
    });
  }
  
  return categorized;
}

async function getAIDescriptions(vars) {
  if (!process.env.OPENAI_API_KEY) return {};
  
  const unknownVars = vars.filter(v => !ENV_PATTERNS[v]);
  if (unknownVars.length === 0) return {};
  
  const openai = new OpenAI();
  
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'Given environment variable names, provide brief descriptions (max 10 words each). Return JSON: {"VAR_NAME": "description"}'
      },
      {
        role: 'user',
        content: `Describe these env vars: ${unknownVars.slice(0, 30).join(', ')}`
      }
    ],
    max_tokens: 500,
    response_format: { type: 'json_object' }
  });
  
  try {
    return JSON.parse(response.choices[0].message.content);
  } catch {
    return {};
  }
}

function generatePlaceholder(varName) {
  if (varName.includes('SECRET') || varName.includes('KEY') || varName.includes('PASSWORD') || varName.includes('TOKEN')) {
    return 'your-secret-here';
  }
  if (varName.includes('URL') || varName.includes('ENDPOINT')) {
    return 'https://example.com';
  }
  if (varName.includes('PORT')) {
    return '3000';
  }
  if (varName === 'NODE_ENV') {
    return 'development';
  }
  if (varName.includes('EMAIL')) {
    return 'user@example.com';
  }
  return '';
}

async function loadExistingEnv(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const vars = {};
    const lines = content.split('\n');
    
    for (const line of lines) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (match) {
        vars[match[1]] = match[2];
      }
    }
    
    return vars;
  } catch {
    return {};
  }
}

function generateEnvFile(categorized, aiDescriptions, existingVars) {
  const lines = [];
  const timestamp = new Date().toISOString().split('T')[0];
  
  lines.push(`# Environment Variables`);
  lines.push(`# Generated by ai-env-gen on ${timestamp}`);
  lines.push(`# https://github.com/lxgicstudios/ai-env-gen`);
  lines.push('');
  
  const categoryOrder = ['Config', 'Auth', 'Database', 'API', 'URL', 'Client', 'Other'];
  const sortedCategories = Object.keys(categorized).sort((a, b) => {
    return categoryOrder.indexOf(a) - categoryOrder.indexOf(b);
  });
  
  for (const category of sortedCategories) {
    const vars = categorized[category];
    if (!vars || vars.length === 0) continue;
    
    lines.push(`# ─────────────────────────────────────`);
    lines.push(`# ${category}`);
    lines.push(`# ─────────────────────────────────────`);
    
    for (const v of vars.sort((a, b) => a.name.localeCompare(b.name))) {
      const desc = v.description || aiDescriptions[v.name] || '';
      if (desc) {
        lines.push(`# ${desc}`);
      }
      
      let value = '';
      if (existingVars[v.name]) {
        value = existingVars[v.name];
      } else if (opts.includeValues) {
        value = generatePlaceholder(v.name);
      }
      
      lines.push(`${v.name}=${value}`);
      lines.push('');
    }
  }
  
  return lines.join('\n');
}

async function main() {
  console.log(chalk.bold.cyan('\n🔧 Environment Variable Generator\n'));
  
  const spinner = ora('Scanning files...').start();
  
  try {
    const files = await getFiles(opts.dir, opts.extensions);
    spinner.text = `Found ${files.length} files`;
    
    // Extract env vars from all files
    const allVars = new Set();
    const varLocations = {};
    
    for (const file of files) {
      const content = await fs.readFile(file, 'utf-8');
      const vars = extractEnvVars(content);
      
      for (const v of vars) {
        allVars.add(v);
        if (!varLocations[v]) varLocations[v] = [];
        varLocations[v].push(path.relative(opts.dir, file));
      }
    }
    
    const varsArray = Array.from(allVars);
    spinner.succeed(`Found ${varsArray.length} environment variables`);
    
    if (varsArray.length === 0) {
      console.log(chalk.yellow('\nNo environment variables found in your code.\n'));
      return;
    }
    
    // Categorize
    const categorized = categorizeVars(varsArray);
    
    // Get AI descriptions
    let aiDescriptions = {};
    if (opts.ai !== false && process.env.OPENAI_API_KEY) {
      const aiSpinner = ora('Getting AI descriptions...').start();
      try {
        aiDescriptions = await getAIDescriptions(varsArray);
        aiSpinner.succeed('AI descriptions added');
      } catch {
        aiSpinner.fail('AI descriptions failed');
      }
    }
    
    // Load existing env file if merging
    let existingVars = {};
    if (opts.merge) {
      existingVars = await loadExistingEnv(path.join(opts.dir, opts.output));
    }
    
    // Generate output
    const envContent = generateEnvFile(categorized, aiDescriptions, existingVars);
    
    // Write file
    const outputPath = path.join(opts.dir, opts.output);
    await fs.writeFile(outputPath, envContent);
    
    console.log(chalk.green(`\n✅ Generated ${opts.output}`));
    
    // Summary
    console.log(chalk.gray('\nVariables by category:'));
    for (const [category, vars] of Object.entries(categorized)) {
      console.log(chalk.white(`  ${category}: ${vars.length}`));
    }
    
    // Show locations
    console.log(chalk.gray('\nUsage locations:'));
    for (const [varName, locations] of Object.entries(varLocations).slice(0, 5)) {
      console.log(chalk.white(`  ${varName}: ${locations[0]}${locations.length > 1 ? ` (+${locations.length - 1})` : ''}`));
    }
    if (Object.keys(varLocations).length > 5) {
      console.log(chalk.gray(`  ... and ${Object.keys(varLocations).length - 5} more`));
    }
    
    console.log(chalk.cyan(`\nNext steps:`));
    console.log(chalk.gray(`  1. Review ${opts.output}`));
    console.log(chalk.gray(`  2. Copy to .env and fill in values`));
    console.log(chalk.gray(`  3. Add .env to .gitignore\n`));
    
  } catch (err) {
    spinner.fail('Scan failed');
    console.error(chalk.red(err.message));
    process.exit(1);
  }
}

main();
