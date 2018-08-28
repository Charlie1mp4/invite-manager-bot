import * as amqplib from 'amqplib';
import DBL from 'dblapi.js';
import { Client, Guild, Message, TextChannel } from 'eris';
import i18n from 'i18n';
import moment from 'moment';

import { guilds, LogAction, members } from './sequelize';
import { Commands } from './services/Commands';
import { DBCache } from './services/DBCache';
import { DBQueue } from './services/DBQueue';
import {
	CreateEmbedFunc,
	Messaging,
	SendEmbedFunc,
	SendReplyFunc,
	ShowPaginatedFunc
} from './services/Messaging';
import { RabbitMq } from './services/RabbitMq';

const config = require('../config.json');

i18n.configure({
	locales: ['en', 'de', 'el', 'en', 'es', 'fr', 'it', 'nl', 'pt', 'ro'],
	defaultLocale: 'en',
	syncFiles: true,
	directory: __dirname + '/../locale',
	objectNotation: true,
	logDebugFn: function(msg: string) {
		console.log('debug', msg);
	},
	logWarnFn: function(msg: string) {
		console.log('warn', msg);
	},
	logErrorFn: function(msg: string) {
		console.log('error', msg);
	}
});

export class IMClient extends Client {
	public version: string;
	public config: any;

	public cache: DBCache;
	public dbQueue: DBQueue;

	public msg: Messaging;
	public createEmbed: CreateEmbedFunc;
	public sendReply: SendReplyFunc;
	public sendEmbed: SendEmbedFunc;
	public showPaginated: ShowPaginatedFunc;

	public rabbitmq: RabbitMq;
	public shardId: number;
	public shardCount: number;

	public cmds: Commands;

	public startedAt: moment.Moment;
	public activityInterval: NodeJS.Timer;

	public numGuilds: number = 0;
	public guildsCachedAt: number = 0;

	public numMembers: number = 0;
	public membersCachedAt: number = 0;

	private dbl: DBL;

	public constructor(
		version: string,
		conn: amqplib.Connection,
		token: string,
		shardId: number,
		shardCount: number,
		_prefix: string
	) {
		super(token, {
			disableEveryone: true,
			firstShardID: shardId - 1,
			lastShardID: shardId - 1,
			maxShards: shardCount,
			disableEvents: {
				TYPING_START: true,
				USER_UPDATE: true,
				PRESENCE_UPDATE: true
			},
			restMode: true,
			messageLimit: 2
		});

		this.startedAt = moment();

		this.version = version;
		this.config = config;

		this.cache = new DBCache(this);
		this.dbQueue = new DBQueue(this);

		this.msg = new Messaging(this);
		this.createEmbed = this.msg.createEmbed.bind(this.msg);
		this.sendReply = this.msg.sendReply.bind(this.msg);
		this.sendEmbed = this.msg.sendEmbed.bind(this.msg);
		this.showPaginated = this.msg.showPaginated.bind(this.msg);

		this.shardId = shardId;
		this.shardCount = shardCount;
		this.rabbitmq = new RabbitMq(this, conn);

		this.cmds = new Commands(this);

		this.on('ready', this.onClientReady);
		this.on('guildCreate', this.onGuildCreate);
		this.on('guildUnavailable', this.onGuildUnavailable);
		this.on('disconnect', this.onDisconnect);
		this.on('connect', this.onConnect);
		this.on('warn', this.onWarn);
		this.on('error', this.onError);
	}

	private async onClientReady(): Promise<void> {
		console.log(`Client ready! Serving ${this.guilds.size} guilds.`);

		await this.cache.init();
		await this.rabbitmq.init();
		await this.cmds.init();

		// Setup discord bots api
		if (this.config.discordBotsToken) {
			this.dbl = new DBL(this.config.discordBotsToken, this);
		}

		this.setActivity();
		this.activityInterval = setInterval(() => this.setActivity(), 30000);
	}

	private async onGuildCreate(guild: Guild): Promise<void> {
		// Send welcome message to owner with setup instructions
		const owner = await guild.getRESTMember(guild.ownerID);
		// TODO: I don't think we have to translate this, right?
		// The default lang is en_us, so at this point it will always be that
		const channel = await owner.user.getDMChannel();
		channel.createMessage(
			'Hi! Thanks for inviting me to your server `' +
				guild.name +
				'`!\n\n' +
				'I am now tracking all invites on your server.\n\n' +
				'To get help setting up join messages or changing the prefix, please run the `!setup` command.\n\n' +
				'You can see a list of all commands using the `!help` command.\n\n' +
				`That's it! Enjoy the bot and if you have any questions feel free to join our support server!\n` +
				'https://discord.gg/2eTnsVM'
		);
	}

	public async logAction(
		guild: Guild,
		message: Message,
		action: LogAction,
		data: any
	) {
		const logChannelId = (await this.cache.get(guild.id)).logChannel;

		if (logChannelId) {
			const logChannel = guild.channels.get(logChannelId) as TextChannel;
			if (logChannel) {
				const content =
					message.content.substr(0, 1000) +
					(message.content.length > 1000 ? '...' : '');

				let json = JSON.stringify(data, null, 2);
				if (json.length > 1000) {
					json = json.substr(0, 1000) + '...';
				}

				const embed = this.createEmbed({
					title: 'Log Action',
					fields: [
						{
							name: 'Action',
							value: action,
							inline: true
						},
						{
							name: 'Cause',
							value: `<@${message.author.id}>`,
							inline: true
						},
						{
							name: 'Command',
							value: content
						},
						{
							name: 'Data',
							value: '`' + json + '`'
						}
					]
				});
				this.sendEmbed(logChannel, embed);
			}
		}

		this.dbQueue.addLogAction(
			{
				id: null,
				guildId: guild.id,
				memberId: message.author.id,
				action,
				message: message.content,
				data,
				createdAt: new Date(),
				updatedAt: new Date()
			},
			{
				id: guild.id,
				name: guild.name,
				icon: guild.iconURL,
				memberCount: guild.memberCount
			},
			{
				id: message.author.id,
				discriminator: message.author.discriminator,
				name: message.author.username
			}
		);
	}

	public async getMembersCount() {
		// If cached member count is older than 5 minutes, update it
		if (Date.now() - this.membersCachedAt > 1000 * 60 * 5) {
			console.log('Fetching guild & member count from DB...');
			this.numMembers = await members.count();
			this.membersCachedAt = Date.now();
		}
		return this.numMembers;
	}

	public async getGuildsCount() {
		// If cached guild count is older than 5 minutes, update it
		if (Date.now() - this.guildsCachedAt > 1000 * 60 * 5) {
			console.log('Fetching guild & member count from DB...');
			this.numGuilds = await guilds.count({
				where: {
					deletedAt: null
				}
			});
			this.guildsCachedAt = Date.now();
		}
		return this.numGuilds;
	}

	private async setActivity() {
		if (this.dbl) {
			this.dbl.postStats(this.guilds.size, this.shardId, this.shardCount);
		}

		const numGuilds = await this.getGuildsCount();
		this.editStatus('online', {
			name: `invitemanager.co - ${numGuilds} servers!`,
			type: 2
		});
	}

	private async onConnect() {
		console.log('DISCORD CONNECT');
	}

	private async onDisconnect() {
		console.log('DISCORD DISCONNECT');
	}

	private async onGuildUnavailable(guild: Guild) {
		console.log('DISCORD GUILD_UNAVAILABLE:', guild.id);
	}

	private async onWarn(info: string) {
		console.log('DISCORD WARNING:', info);
	}

	private async onError(error: Error) {
		console.log('DISCORD ERROR:', error);
	}
}
