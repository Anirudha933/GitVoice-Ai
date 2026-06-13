import axios from "axios";

export async function scrapeGithub(username: string) {
    // Connect directly without proxy for local testing
    const userRepos = await axios.request({
        url: `https://api.github.com/users/${username}/repos`,
        headers: {
            "User-Agent": "ai-interviewer"
        }
    });
    return userRepos.data.map((x: any) => ({
        description: x.description,
        name: x.name,
        fullName: x.full_name,
        starCount: x.stargazers_count
    }))

}