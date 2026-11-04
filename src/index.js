import 'dotenv/config';

import {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder
} from 'discord.js';

import {
    LavalinkManager,
    NodeType,
    NodeLinkDefaultSources
} from 'lavalink-client';

const token = process.env.DISCORD_TOKEN;
const uri = process.env.LAVALINK_URI;
const password = process.env.LAVALINK_PASSWORD;

if (!token || !uri || !password) {
    console.error('Environment Discord atau NodeLink belum lengkap!');
    process.exit(1);
}

const nodeURL = new URL(uri);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

client.lavalink = new LavalinkManager({
    nodes: [{
        id: 'ZOMA-NODELINK',
        host: nodeURL.hostname,
        port: Number(nodeURL.port || (nodeURL.protocol === 'https:' ? 443 : 80)),
        authorization: password,
        secure: nodeURL.protocol === 'https:',
        nodeType: NodeType.NodeLink,
        retryAmount: 10,
        retryDelay: 5000
    }],

    sendToShard: (guildId, payload) => {
        client.guilds.cache
            .get(guildId)?.shard?.send(payload);
    },

    autoSkip: true,

    client: {
        id: '0',
        username: 'ZOMA APP'
    }
});

client.lavalink.utils.SourcesRecord = NodeLinkDefaultSources;

client.on('raw', data => {
    client.lavalink.sendRawData(data);
});

client.once('ready', async () => {
    console.log('================================');
    console.log('       ZOMA APP ONLINE 🎩');
    console.log('================================');
    console.log(`Bot: ${client.user.tag}`);

    client.lavalink.options.client.id = client.user.id;
    client.lavalink.init(client.user);

    const commands = [
        new SlashCommandBuilder()
            .setName('ping')
            .setDescription('Cek status ZOMA APP')
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(token);

    await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commands }
    );

    console.log('Slash commands berhasil disinkronkan.');
});

client.lavalink.nodeManager.on('connect', node => {
    console.log(`NodeLink CONNECTED: ${node.id}`);
});

client.lavalink.nodeManager.on('error', (node, error) => {
    console.error(`NodeLink ERROR: ${node.id}`, error);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'ping') {
        await interaction.reply({
            content: `🏓 Pong! ZOMA APP aktif. Latency: ${client.ws.ping}ms`,
            ephemeral: true
        });
    }
});

client.login(token).catch(error => {
    console.error('Discord login gagal:', error);
    process.exit(1);
});
