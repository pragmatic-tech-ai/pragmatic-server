import HelloAppApp from "./main.js"

Application
{
    resources:
    {
        ContentPresenter x:root [ Content = $service(HelloAppApp) ]

        DataTemplate [ DataType = HelloAppApp ]
        {
            StackPanel [ Orientation = Vertical, Margin = (16,16,16,16) ]
            {
                TextBlock [ Text = $HelloText ]
            }
        }
    }
}
