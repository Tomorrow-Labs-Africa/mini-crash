import { Play } from '../models/player';

class SortedArray<T extends Play> {
  private arr: T[] = [];

  // Comparison function for sorting based on bet and username
  private cmp(a: T, b: T): number {
    const betDiff = b.bet - a.bet;
    if (betDiff !== 0) return betDiff;
    return a.user.username < b.user.username ? 1 : -1;
  }

  // Inserts an element into the sorted array
  public insert(v: T): number {
    if (this.arr.length === 0) {
      this.arr.push(v);
      return 0;
    }

    const index = this.binarySearch(v);
    this.arr.splice(index, 0, v);

    return index;
  }

  // Performs binary search using the custom compare function
  private binarySearch(value: T): number {
    let low = 0;
    let high = this.arr.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const comparison = this.cmp(value, this.arr[mid]);
      if (comparison === 0) {
        return mid; // Found exact value, return index
      } else if (comparison < 0) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    // Not found, return insertion point based on comparison
    return low;
  }

  // Gets the element at a specific index
  public get(i: number): T | undefined {
    return this.arr[i];
  }

  // Gets the entire sorted array
  public getArray(): T[] {
    return this.arr;
  }

  // Clears the array
  public clear(): void {
    this.arr = [];
  }
}

export default SortedArray;