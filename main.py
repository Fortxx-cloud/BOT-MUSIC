import os
import discord
import wavelink

from discord import app_commands
from discord.ext import commands
from dotenv import load_dotenv

load_dotenv()

TOKEN = os.getenv("DISCORD_TOKEN")
LAVALINK_URI = os.getenv("LAVALINK_URI")
LAVALINK_PASSWORD = os.getenv("LAVALINK_PASSWORD")


class BlackEmpireMusic(commands.Bot):

    def __init__(self):
        intents = discord.Intents.default()
        super().__init__(
            command_prefix="!",
            intents=intents
        )

    async def setup_hook(self):
        if LAVALINK_URI and LAVALINK_PASSWORD:
            node = wavelink.Node(
                uri=LAVALINK_URI,
                password=LAVALINK_PASSWORD,
                identifier="BLACK-EMPIRE"
            )

            await wavelink.Pool.connect(
                client=self,
                nodes=[node]
            )

        await self.tree.sync()

    async def on_ready(self):
        print(f"BLACK EMPIRE MUSIC ONLINE")
        print(f"Bot: {self.user}")
        await self.change_presence(
            activity=discord.Activity(
                type=discord.ActivityType.listening,
                name="BLACK EMPIRE MUSIC"
            )
        )

    async def on_wavelink_track_end(self, payload):
        player = payload.player

        if player.queue:
            next_track = player.queue.get()
            await player.play(next_track)


bot = BlackEmpireMusic()


def get_player(interaction):
    return interaction.guild.voice_client


async def connect_player(interaction):
    if not interaction.user.voice:
        raise ValueError("Masuk voice channel terlebih dahulu.")

    channel = interaction.user.voice.channel
    player = get_player(interaction)

    if not player:
        player = await channel.connect(cls=wavelink.Player)
    elif player.channel != channel:
        await player.move_to(channel)

    return player


@bot.tree.command(name="play", description="Putar musik")
@app_commands.describe(query="Judul lagu atau URL")
async def play(interaction: discord.Interaction, query: str):

    await interaction.response.defer()

    try:
        player = await connect_player(interaction)
        tracks = await wavelink.Playable.search(query)

        if not tracks:
            return await interaction.followup.send(
                "Lagu tidak ditemukan."
            )

        track = tracks[0]
        await player.queue.put_wait(track)

        if not player.playing and not player.paused:
            await player.play(player.queue.get())

        embed = discord.Embed(
            title="🎵 Lagu masuk antrean",
            description=f"**[{track.title}]({track.uri})**",
            color=0x5865F2
        )

        embed.add_field(
            name="Artist",
            value=track.author,
            inline=True
        )

        embed.set_footer(
            text="BLACK EMPIRE MUSIC"
        )

        await interaction.followup.send(embed=embed)

    except Exception as error:
        await interaction.followup.send(
            f"Terjadi kesalahan: {error}"
        )


@bot.tree.command(name="pause", description="Jeda musik")
async def pause(interaction: discord.Interaction):

    player = get_player(interaction)

    if not player or not player.playing:
        return await interaction.response.send_message(
            "Tidak ada musik yang diputar."
        )

    await player.pause(True)
    await interaction.response.send_message("⏸️ Musik dijeda.")


@bot.tree.command(name="resume", description="Lanjutkan musik")
async def resume(interaction: discord.Interaction):

    player = get_player(interaction)

    if not player or not player.paused:
        return await interaction.response.send_message(
            "Musik tidak sedang dijeda."
        )

    await player.pause(False)
    await interaction.response.send_message("▶️ Musik dilanjutkan.")


@bot.tree.command(name="skip", description="Lewati lagu")
async def skip(interaction: discord.Interaction):

    player = get_player(interaction)

    if not player or not player.playing:
        return await interaction.response.send_message(
            "Tidak ada musik."
        )

    await player.skip()
    await interaction.response.send_message("⏭️ Lagu dilewati.")


@bot.tree.command(name="stop", description="Hentikan musik")
async def stop(interaction: discord.Interaction):

    player = get_player(interaction)

    if not player:
        return await interaction.response.send_message(
            "Bot tidak sedang berada di voice channel."
        )

    player.queue.clear()
    await player.stop()

    await interaction.response.send_message(
        "⏹️ Musik dihentikan."
    )


@bot.tree.command(name="queue", description="Lihat antrean musik")
async def queue(interaction: discord.Interaction):

    player = get_player(interaction)

    if not player:
        return await interaction.response.send_message(
            "Bot belum memutar musik."
        )

    tracks = list(player.queue)

    if not tracks:
        return await interaction.response.send_message(
            "Antrean masih kosong."
        )

    description = ""

    for index, track in enumerate(tracks[:10], start=1):
        description += f"**{index}.** {track.title}\n"

    embed = discord.Embed(
        title="🎶 MUSIC QUEUE",
        description=description,
        color=0x5865F2
    )

    await interaction.response.send_message(embed=embed)


@bot.tree.command(name="volume", description="Atur volume musik")
@app_commands.describe(level="Volume 1 sampai 100")
async def volume(interaction: discord.Interaction, level: int):

    player = get_player(interaction)

    if not player:
        return await interaction.response.send_message(
            "Bot belum memutar musik."
        )

    if level < 1 or level > 100:
        return await interaction.response.send_message(
            "Volume harus 1 sampai 100."
        )

    await player.set_volume(level)

    await interaction.response.send_message(
        f"🔊 Volume diatur ke {level}%."
    )


@bot.tree.command(name="leave", description="Keluarkan bot dari voice")
async def leave(interaction: discord.Interaction):

    player = get_player(interaction)

    if not player:
        return await interaction.response.send_message(
            "Bot tidak ada di voice channel."
        )

    await player.disconnect()

    await interaction.response.send_message(
        "👋 BLACK EMPIRE MUSIC keluar dari voice."
    )


if not TOKEN:
    raise RuntimeError("DISCORD_TOKEN belum diatur.")

bot.run(TOKEN)
