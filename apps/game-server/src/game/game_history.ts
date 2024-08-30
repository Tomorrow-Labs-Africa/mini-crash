class GameHistory<T> {
  private gameTable: T[];

  constructor(gameTable: T[] = []) {
      this.gameTable = gameTable.slice(-20); // Keep only the last 20 games
  }

  addCompletedGame(game: T): void {
      if (this.gameTable.length >= 20) {
          this.gameTable.pop(); // Remove the oldest game if we exceed 20
      }
      this.gameTable.unshift(game); // Add the new game to the start
  }

  getHistory(): T[] {
      return [...this.gameTable]; // Return a shallow copy of the game table
  }
}

export default GameHistory;
