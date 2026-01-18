import { Component } from "../component";

interface TestProps {
  message: string;
}

export class TestComponent extends Component<TestProps> {
  render() {
    return (
      <div className="test-component">
        <p>{this.props.message}</p>
        <button onClick={() => console.log("clicked!")}>Click me</button>
      </div>
    ) as HTMLElement;
  }
}
